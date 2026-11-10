include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-workbuddy2api
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=Alex Zhong <alexzhong233@users.noreply.github.com>

LUCI_TITLE:=WorkBuddy2API 四选一安装（本地/容器 × 原版/Rust）
LUCI_DESCRIPTION:=把 WorkBuddy2API 的四种装法做成一页：本地·原版（官方 apk/ipk）、\
容器·原版、本地·Rust（静态 musl 单文件）、容器·Rust。四套共用同一个数据目录，\
装哪个都读同一份账号；带版本检测、启停与卸载。
LUCI_PKGARCH:=all
# curl 用来查上游版本、下安装包；docker 与 python3 都是可选的——装容器版才要
# docker，装本地·原版时由上游包自己把 python3 依赖带进来，所以都不写进依赖。
LUCI_DEPENDS:=+luci-base +curl

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
