#!/bin/sh
# 把 luci-app-workbuddy2api 的文件从 GitHub 拉到路由器上，不重刷固件就能用。
#
# 用法（两条任选，哪条通走哪条）：
#   curl -fsSL https://raw.githubusercontent.com/alexzhong233/luci-app-workbuddy2api/main/deploy.sh | sh
#   curl -fsSL https://cdn.jsdelivr.net/gh/alexzhong233/luci-app-workbuddy2api@main/deploy.sh | sh
#
# 幂等：重复执行就是覆盖同一批文件。刷机后 overlay 被清空，重跑一次即可。
# 这个包本身不含 WorkBuddy2API —— 应用由页面里的四个安装按钮按需下载。

REPO="alexzhong233/luci-app-workbuddy2api"
BRANCH="main"

RAW="https://raw.githubusercontent.com/$REPO/$BRANCH"
CDN="https://cdn.jsdelivr.net/gh/$REPO@$BRANCH"

TMP="/tmp/wb2api-luci-deploy.$$"
mkdir -p "$TMP" || exit 1
trap 'rm -rf "$TMP"' EXIT

log() { echo "== $*"; }
die() { echo "!! $*" >&2; exit 1; }

fetch() {
	local rel="$1" out="$2"

	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --connect-timeout 10 --max-time 60 -o "$out" "$RAW/$rel" && return 0
		log "raw.githubusercontent.com 拉取失败，换 jsDelivr"
		curl -fsSL --connect-timeout 10 --max-time 60 -o "$out" "$CDN/$rel" && return 0
	elif command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch -q -O "$out" "$RAW/$rel" && return 0
		log "raw.githubusercontent.com 拉取失败，换 jsDelivr"
		uclient-fetch -q -O "$out" "$CDN/$rel" && return 0
	else
		die "没有 curl 或 uclient-fetch，装一个：apk add curl"
	fi

	return 1
}

install_file() {
	local rel="$1" dst="$2" mode="$3" base

	base=$(basename "$rel")
	log "下载 $base"
	fetch "$rel" "$TMP/$base" || die "$rel 下载失败（两条线路都不通）"

	# 拉回来的必须是个真文件：404 页面、被 .gitignore 吞掉的占位都可能只有
	# 几十字节，直接铺上去会留下一个坏脚本。
	[ -s "$TMP/$base" ] || die "$rel 内容为空"
	[ "$(wc -c <"$TMP/$base")" -gt 100 ] || die "$rel 只有 $(wc -c <"$TMP/$base") 字节，不像正常内容"

	mkdir -p "$(dirname "$dst")" || die "无法创建 $(dirname "$dst")"
	cp -f "$TMP/$base" "$dst" || die "写入 $dst 失败"
	chmod "$mode" "$dst"
	echo "   -> $dst ($(wc -c <"$dst") 字节)"
}

install_file "root/usr/libexec/workbuddy2api-ctl" \
	"/usr/libexec/workbuddy2api-ctl" 0755
install_file "root/etc/init.d/workbuddy2api-rust" \
	"/etc/init.d/workbuddy2api-rust" 0755
install_file "root/usr/share/luci/menu.d/luci-app-workbuddy2api.json" \
	"/usr/share/luci/menu.d/luci-app-workbuddy2api.json" 0644
install_file "root/usr/share/rpcd/acl.d/luci-app-workbuddy2api.json" \
	"/usr/share/rpcd/acl.d/luci-app-workbuddy2api.json" 0644
install_file "htdocs/luci-static/resources/view/workbuddy2api/status.js" \
	"/www/luci-static/resources/view/workbuddy2api/status.js" 0644

log "重启 rpcd 并清 LuCI 缓存"
/etc/init.d/rpcd restart >/dev/null 2>&1
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* 2>/dev/null

log "自检"
/usr/libexec/workbuddy2api-ctl status 2>/dev/null | head -n 8 || true

cat <<'EOF'

装好了。浏览器 Ctrl+Shift+R（Mac 是 Cmd+Shift+R）强刷，左侧菜单：
  服务 → WorkBuddy2API

页面里四个标签，四选一：
  本地·原版   官方 apk/ipk（Python），带 python3 依赖，约 15MB 落 overlay
  容器·原版   ghcr.io/ardeyouxipianyi/workbuddy2api-hub 镜像，host 网络
  本地·Rust   静态 musl 单文件，约 20MB 落 overlay
  容器·Rust   Rust 版镜像，host 网络

四套共用同一个数据目录（默认 /mnt/sda1/Configs/workbuddy2api），
换实现只换运行方式，accounts/ 里的账号和 usage/ 的记录都不动。
装了一套之后其它三个的安装按钮会变灰，要先卸载再装。

命令行等价：
  /usr/libexec/workbuddy2api-ctl status
  /usr/libexec/workbuddy2api-ctl install rust 8788 /mnt/sda1/Configs/workbuddy2api
  /usr/libexec/workbuddy2api-ctl install python-docker 8788 /mnt/sda1/Configs/workbuddy2api
  /usr/libexec/workbuddy2api-ctl latest all
EOF
