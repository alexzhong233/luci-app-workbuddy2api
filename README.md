# luci-app-workbuddy2api

在 OpenWrt 上装 [WorkBuddy2API](https://github.com/ardeyouxipianyi/workbuddy2api-hub) 的 LuCI 页面，
**四种装法四选一**，共用同一份账号数据。

| 标签 | 跑什么 | 来源 | 占用 |
|---|---|---|---|
| 本地·原版 | `python3 -m wb_proxy`，procd 托管 | 上游 apk / ipk | overlay 约 15MB（含 python3 依赖） |
| 容器·原版 | `wb-proxy` 容器 | `ghcr.io/ardeyouxipianyi/workbuddy2api-hub` | docker 数据盘约 200MB |
| 本地·Rust | `/usr/bin/wb-backend`，静态 musl 单文件 | [YTjungle666 的 Rust 重写分支](https://github.com/YTjungle666/workbuddy2api-hub) | overlay 约 20MB，无运行时依赖 |
| 容器·Rust | `wb-proxy` 容器 | `ghcr.io/ytjungle666/workbuddy2api-hub` | docker 数据盘，不占 overlay |

页面顶部一个不会点的彩色按钮，直接写清现在跑的是哪一种、是哪个版本、地址是什么。
**装了一套之后，其它三栏的安装按钮变灰**，并提示先去哪一栏卸载——四套抢同一个端口（8788）
和同一份数据目录，同时跑会互相覆盖。

## 数据目录：四套共通，可自定义

```
/mnt/sda1/Configs/workbuddy2api/       # 默认值，装之前可以改（必须在 /mnt 下）
├── accounts/                          # 每账号一个 JSON（含 OAuth token，权限 700）
├── usage/                             # 用量日志
└── subbridge-data/                    # 只有原版用得上的子桥数据
```

四个版本指向的是**同一个** `accounts/` 与 `usage/`：

- 本地·原版 → 上游 `init.d` 的 `accounts_dir` / `usage_dir`（写在 `/etc/config/workbuddy2api`）
- 本地·Rust → `--accounts-dir` / `--usage-dir`（读同一份 uci）
- 容器·原版 → 挂 `$DATADIR/accounts:/app/accounts`、`$DATADIR/usage:/app/usage`
- 容器·Rust → 挂 `$DATADIR:/data`（镜像默认就是 `/data/accounts`、`/data/usage`）

所以**换实现不用重新导入账号**：卸载（保留数据）→ 换一栏装 → 账号、额度记录原样接上。
页面顶部会显示 `accounts/` 里有多少个 JSON，切换前后数字一致就说明数据接上了。

因为目录和端口是共用的，装好之后这两项在页面上就锁住了；要换目录请先卸载。

## 版本检测

点「检查更新」查两个上游的最新版本（原版看 GitHub Releases，Rust 分支看 tag），
和本机已装版本对比，有新版就在顶部标红，并给出「更新到 vX」按钮。

已装版本优先读数据目录里的 `.wb2api-<实现>.version`，其次从包数据库 / 镜像标签 /
`wb-backend --version` 推断——这四种来源覆盖了刷机、手动 `docker run` 等跑偏的情况。

## 命令

```sh
workbuddy2api-ctl status                       # 四套的完整状态（页面用的就是这个）
workbuddy2api-ctl latest [python|rust|all]     # 查上游最新版本
workbuddy2api-ctl disks                        # /mnt 下的数据目录候选

workbuddy2api-ctl install python         [端口] [数据目录] [版本]
workbuddy2api-ctl install python-docker  [端口] [数据目录] [镜像标签]
workbuddy2api-ctl install rust           [端口] [数据目录] [版本]
workbuddy2api-ctl install rust-docker    [端口] [数据目录] [镜像标签]

workbuddy2api-ctl update <实现>
workbuddy2api-ctl start|stop|restart <实现>
workbuddy2api-ctl remove <实现> [purge]
workbuddy2api-ctl logs <实现>
```

安装与更新都在后台跑（下 8-20MB 包 / 拉 200MB 镜像 / 起服务），页面轮询进度，不会超时。

## 几个实现上的事实

- **Rust 版现在没有 release 资产**，只有 tag。ctl 先试 `releases/download/<tag>/wb-backend-<ver>-linux-aarch64`，
  404 就 `docker pull` 同版本镜像、`docker create` + `docker cp` 把 `/usr/local/bin/wb-backend`
  抠出来——镜像里那个就是静态 musl 二进制，路由器的 aarch64 上能直接跑。
  所以「本地·Rust」这一栏在没装 Docker 的机器上，只能等上游补 release。
- **端口用 host 网络**：容器版不写 `ports` 映射，直接用 `network_mode: host`，容器内端口就是
  宿主端口。这样本地版、容器版对局域网暴露的地址完全一样，切换时客户端不用改。
  代价是别的容器不能再用 `wb-proxy:8788` 这个名字直连，得用 `<路由器IP>:8788`。
- **`--lan` 一定带上**：两个实现都以 `--lan` 启动，监听 0.0.0.0 时强制要求 API Key，
  否则网关就裸奔在局域网上，谁都能耗你的账号额度。
- **原版的 apk/ipk 是 `_all` 纯 Python 包**，装的时候要能连 OpenWrt 软件源拉 python3 等依赖
  （约 15MB）。源不通就装不上，页面会提前提示。
- **Rust 版自带的自更新被关掉**（`WB_UPDATE_INSTALL_ENABLED=0`）：它换的是磁盘上的二进制，
  procd 的 `command` 是绝对路径不会跟着变，统一走页面的「更新」更可控。
- **面板卡顿的老问题**：`WB_STATS_TTL=900`（原版）是必须的。应用默认 15 秒，面板每 5 秒轮询，
  每次缓存过期都要全量重扫 `usage.jsonl`，在这台路由器上要十几秒。ctl 写 uci 时会一起写上。
- **卸载默认保留数据**，只有勾「卸载并删除数据」才会动 `accounts/`——账号凭据在里面，
  删了要重新 OAuth。

## 装这个包

```sh
# 编进固件
CONFIG_PACKAGE_luci-app-workbuddy2api=y

# 单独编译
git clone https://github.com/alexzhong233/luci-app-workbuddy2api package/luci-app-workbuddy2api
make package/luci-app-workbuddy2api/compile
```

不重刷固件（幂等，刷完机重跑一次）：

```sh
curl -fsSL https://raw.githubusercontent.com/alexzhong233/luci-app-workbuddy2api/main/deploy.sh | sh
```

菜单在 **服务 → WorkBuddy2API**。包本身只有页面 + ctl + 一个 procd 脚本（Rust 版用），
**不含应用本体**——四种实现都由页面按需下载安装。

依赖 `luci-base`、`curl`。docker 与 python3 都不写进依赖：装容器版才要 docker，
装本地·原版时 python3 由上游包自己带进来。

## 许可证

MIT，见 [LICENSE](LICENSE)。WorkBuddy2API 本身是上游作者的产物，遵循它自己的许可证；
它做的是逆向协议，使用风险自负。
