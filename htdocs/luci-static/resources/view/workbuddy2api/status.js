'use strict';
'require view';
'require fs';
'require ui';
'require poll';

var TOOL = '/usr/libexec/workbuddy2api-ctl';

/* 四选一。id 直接就是 ctl 的 install 参数。 */
var VARIANTS = [
	{
		id: 'python',
		title: _('本地·原版'),
		how: _('官方 OpenWrt 包（apk/ipk），Python 实现'),
		notes: [
			_('procd 托管 python3 -m wb_proxy，参数全部走 /etc/config/workbuddy2api。'),
			_('会连带装 python3 等依赖，约 15MB 落在 overlay。'),
			_('网关地址 http://<路由器IP>:<端口>/v1，看板在根路径。')
		],
		field: 'tag',
		fieldLabel: _('版本'),
		fieldHint: _('留空 = 上游最新 release，例如 v2.0.7')
	},
	{
		id: 'python-docker',
		title: _('容器·原版'),
		how: _('官方镜像 ghcr.io/ardeyouxipianyi/workbuddy2api-hub'),
		notes: [
			_('docker compose 起 wb-proxy，host 网络，容器内端口就是宿主端口。'),
			_('账号挂 /app/accounts、用量挂 /app/usage，都指向数据目录下的同一份。'),
			_('不占 overlay，镜像约 200MB 落在 docker 数据盘。')
		],
		field: 'tag',
		fieldLabel: _('镜像标签'),
		fieldHint: _('留空 = 上游最新，例如 v2.0.7')
	},
	{
		id: 'rust',
		title: _('本地·Rust'),
		how: _('Tjungle666 的 Rust 重写分支，单文件静态 musl 二进制'),
		notes: [
			_('无 Python 运行时依赖，约 20MB 落在 overlay，procd 托管 /usr/bin/wb-backend。'),
			_('上游现在只有 tag 没有 release 资产，ctl 会自动从同版本镜像里把二进制抠出来。'),
			_('功能对齐上游 v2.0.1，面板与 API 路径一致。')
		],
		field: 'tag',
		fieldLabel: _('版本'),
		fieldHint: _('留空 = 上游最新 tag，例如 v2.0.1.2')
	},
	{
		id: 'rust-docker',
		title: _('容器·Rust'),
		how: _('Rust 版镜像 ghcr.io/ytjungle666/workbuddy2api-hub'),
		notes: [
			_('docker compose 起 wb-proxy，host 网络，整个数据目录挂到容器的 /data。'),
			_('镜像自带的多架构产物，arm64 可用；不占 overlay。')
		],
		field: 'tag',
		fieldLabel: _('镜像标签'),
		fieldHint: _('留空 = 上游最新，例如 2.0.1.2（镜像标签不带 v）')
	}
];

function variantOf(id) {
	for (var i = 0; i < VARIANTS.length; i++)
		if (VARIANTS[i].id === id)
			return VARIANTS[i];

	return null;
}

var KNOWN_KINDS = [ 'python', 'python-docker', 'rust', 'rust-docker' ];

function call(args) {
	return fs.exec(TOOL, args).then(function(res) {
		var text = ((res && res.stdout) || '') + ((res && res.stderr) || '');

		return { code: res ? res.code : 1, text: String(text).replace(/\s+$/, '') };
	}).catch(function(err) {
		return { code: 1, text: '执行失败：' + (err && err.message ? err.message : err) };
	});
}

function parseKV(text) {
	var out = {};

	(text || '').split('\n').forEach(function(line) {
		var idx = line.indexOf('=');

		if (idx > 0)
			out[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
	});

	return out;
}

function parseDisks(text) {
	return (text || '').split('\n').map(function(line) {
		var m = /^disk=(.+):(\d+)$/.exec(line.trim());

		return m ? { mount: m[1], free: parseInt(m[2], 10) } : null;
	}).filter(function(x) { return x; });
}

function flag(v) {
	return String(v) === '1';
}

function int(v) {
	return parseInt(v, 10) || 0;
}

function vnum(v) {
	return String(v || '').replace(/^v/, '');
}

function mb(kb) {
	var n = int(kb);

	return n >= 1048576 ? (n / 1048576).toFixed(1) + ' GB' : Math.round(n / 1024) + ' MB';
}

function muted(text) {
	return E('span', { 'class': 'cbi-value-description' }, [ text ]);
}

function link(url, text) {
	if (!url)
		return muted('—');

	return E('a', { 'href': url, 'target': '_blank', 'rel': 'noopener' }, [ text || url ]);
}

function sfx(id) {
	return String(id).replace(/-/g, '_');
}

function sf(st, id, name) {
	return st[sfx(id) + '_' + name];
}

function isPresent(st, id) {
	return flag(sf(st, id, 'present'));
}

function isRunning(st, id) {
	return flag(sf(st, id, 'running'));
}

function verOf(st, id) {
	return sf(st, id, 'version') || '';
}

function latestOf(st, id) {
	return String(id).indexOf('python') === 0 ? (st.latest_python || '') : (st.latest_rust || '');
}

function kindTitle(kind) {
	var v = variantOf(kind);

	return v ? v.title : '';
}

function parseTask(s) {
	var raw = String(s || 'idle');
	var i = raw.indexOf(':');

	return i > 0
		? { phase: raw.substring(0, i), detail: raw.substring(i + 1) }
		: { phase: raw, detail: '' };
}

var PHASE_TEXT = {
	pulling: _('拉取镜像'),
	downloading: _('下载'),
	installing: _('安装'),
	starting: _('等待服务就绪'),
	done: _('完成'),
	error: _('失败'),
	idle: _('空闲')
};

function busy(phase) {
	return phase === 'pulling' || phase === 'downloading'
		|| phase === 'installing' || phase === 'starting';
}

/* 表格用 CSS Grid 而不是 <table>：第三方主题对 th/td 有高特定性的 !important
 * 规则，会把表头和数据行拆成不同盒模型，用 table 一定会错位。 */
var CSS = [
	'.wb-wrap { overflow-x: auto; }',
	'.wb-grid { display: grid; grid-template-columns: 10rem minmax(14rem, 1fr); min-width: 28rem; }',
	'.wb-k { padding: .45rem .6rem; font-weight: bold;',
	'  border-bottom: 1px solid rgba(128,128,128,.18); }',
	'.wb-c { padding: .45rem .6rem; border-bottom: 1px solid rgba(128,128,128,.18); }',
	'.wb-form { display: grid; grid-template-columns: 10rem minmax(12rem, 26rem);',
	'  gap: .5rem .8rem; align-items: center; }',
	'.wb-form input[type=text], .wb-form select { width: 100%; box-sizing: border-box; }',
	'.wb-actions .btn { margin-right: .5rem; margin-bottom: .5rem; }',
	'.wb-tabs { display: flex; flex-wrap: wrap; gap: .4rem; margin: 1.2rem 0 0;',
	'  border-bottom: 1px solid rgba(128,128,128,.3); }',
	'.wb-tab { padding: .5rem 1.1rem; cursor: pointer; border: 1px solid transparent;',
	'  border-bottom: 0; border-radius: .35rem .35rem 0 0; background: transparent;',
	'  color: inherit; font: inherit; margin-bottom: -1px; }',
	'.wb-tab.on { border-color: rgba(128,128,128,.3); background: rgba(128,128,128,.12);',
	'  font-weight: bold; }',
	'.wb-tab .wb-tag { font-size: .8em; opacity: .75; }',
	'.wb-task { margin-top: 1rem; padding: .6rem .8rem; border-left: 3px solid #3b82f6;',
	'  background: rgba(59,130,246,.08); }',
	'.wb-task.err { border-left-color: #dc2626; background: rgba(220,38,38,.08); }',
	'.wb-task.ok { border-left-color: #16a34a; background: rgba(22,163,74,.08); }',
	'.wb-warn { color: #d97706; }',
	'.wb-up { color: #dc2626; font-weight: bold; }',
	'.wb-alert { margin: .8rem 0; padding: .6rem .8rem; border-left: 3px solid #d97706;',
	'  background: rgba(217,119,6,.09); }',
	'.wb-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }'
].join('\n');

return view.extend({
	load: function() {
		return Promise.all([
			call([ 'status' ]),
			call([ 'disks' ])
		]);
	},

	render: function(results) {
		var state = {
			tab: 'python',
			pinned: false,
			st: parseKV(results[0] ? results[0].text : ''),
			disks: parseDisks(results[1] ? results[1].text : ''),
			sig: ''
		};

		var out = E('pre', {
			'id': 'wb-out',
			'style': 'max-height:18rem;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:1rem 0 0'
		}, [ _('（还没有执行任何操作）') ]);

		var headWrap = E('div');
		var sharedWrap = E('div');
		var tabWrap = E('div', { 'class': 'wb-tabs' });
		var paneWrap = E('div');

		/* ---- 共享字段：四栏共用一套端口与数据目录，所以只建一次 ---- */
		var fPort = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'value': state.st.port || '8788'
		});

		var fDir = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'value': state.st.datadir || '/mnt/sda1/Configs/workbuddy2api'
		});

		var dirSel = E('select', {
			'class': 'cbi-input-select',
			'change': function(ev) { if (ev.target.value) fDir.value = ev.target.value; }
		}, [ E('option', { 'value': '' }, [ _('从检测到的磁盘里选…') ]) ].concat(
			state.disks.map(function(d) {
				return E('option', { 'value': d.mount + '/Configs/workbuddy2api' },
					[ d.mount + '/Configs/workbuddy2api  (' + _('剩余 %s').format(mb(d.free)) + ')' ]);
			})));

		sharedWrap.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('通用设置') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('四个版本共用同一个数据目录和端口：accounts/ 里每个账号一个 JSON，usage/ 里是用量日志。'),
				E('br'),
				_('换实现只是换运行方式，账号和额度记录原地不动；装好之后这两项就不再改，要换目录请先卸载。')
			]),
			E('div', { 'class': 'wb-form', 'style': 'margin-top:1rem' }, [
				E('label', {}, [ _('监听端口') ]), fPort,
				E('label', {}, [ _('数据目录') ]),
				E('div', {}, [ dirSel, fDir, muted(' ' + _('必须在 /mnt 下')) ])
			])
		]));

		function setOut(text) {
			out.textContent = text || _('（无输出）');
		}

		function clear(node) {
			while (node.firstChild)
				node.removeChild(node.firstChild);
		}

		function refresh(force) {
			return call([ 'status' ]).then(function(res) {
				state.st = parseKV(res.text);
				drawAll(force);
				return state.st;
			});
		}

		function run(args, label) {
			setOut(_('正在执行：') + label + ' ...');

			return call(args).then(function(res) {
				setOut('$ workbuddy2api-ctl ' + args.join(' ') + '\n\n' + (res.text || _('（无输出）')));

				if (res.code !== 0)
					ui.addNotification(null, E('p', {}, [
						label + _(' 失败（退出码 %s），看下方输出').format(res.code)
					]), 'danger');

				return refresh(true);
			});
		}

		function button(label, args, opts) {
			opts = opts || {};

			return E('button', {
				'class': 'btn cbi-button' + (opts.primary ? ' cbi-button-apply' : '') +
					(opts.danger ? ' cbi-button-reset' : ''),
				'disabled': opts.disabled ? 'disabled' : null,
				'click': function(ev) {
					ev.preventDefault();

					if (opts.confirm && !window.confirm(opts.confirm))
						return;

					return run(args, label);
				}
			}, [ label ]);
		}

		/* ---------------- 顶部状态 ---------------- */
		function drawHead(st) {
			var kind = st.kind || 'none';
			var running = flag(st.running) && kind !== 'none';
			var t = parseTask(st.task);
			var rows = [];

			function row(k, v) {
				rows.push([
					E('div', { 'class': 'wb-k' }, [ k ]),
					E('div', { 'class': 'wb-c' }, Array.isArray(v) ? v : [ v ])
				]);
			}

			var label = kind === 'none'
				? _('WorkBuddy2API 未安装')
				: _('WorkBuddy2API 正在运行（%s）').format(kindTitle(kind));

			if (kind !== 'none' && !running)
				label = _('WorkBuddy2API 已停止（%s）').format(kindTitle(kind));

			var headBtn = E('button', {
				'class': 'btn cbi-button ' + (running ? 'cbi-button-success' : 'cbi-button-negative'),
				'disabled': 'disabled',
				'style': 'cursor:default;min-width:16rem;opacity:1'
			}, [ label ]);

			var openBtn = running && st.address
				? E('a', {
					'class': 'btn cbi-button cbi-button-action',
					'href': st.address,
					'target': '_blank',
					'rel': 'noopener'
				}, [ _('打开看板') ])
				: '';

			row(_('状态'), E('div', { 'class': 'wb-head' }, [ headBtn, openBtn ]));

			if (kind !== 'none') {
				var cur = st.version || '';
				var newv = latestOf(st, kind);
				var cell = [ E('code', {}, [ cur ? 'v' + vnum(cur) : '—' ]) ];

				if (newv && cur && vnum(newv) !== vnum(cur))
					cell.push(E('span', { 'class': 'wb-up', 'style': 'margin-left:.6rem' },
						[ _('有新版本 %s').format(newv) ]));
				else if (newv && cur)
					cell.push(muted(' ' + _('（已是最新）')));
				else if (!newv)
					cell.push(muted(' ' + _('（点下面的「检查更新」查上游）')));

				row(_('已装版本'), cell);
				row(_('访问地址'), link(st.address));
				row(_('API 地址'), link(st.address ? st.address + '/v1' : ''));
				if (!flag(st.listening) && running)
					row(_('端口'), [ st.port, warn(_(' 没有监听')) ]);
			}
			else {
				row(_('已装版本'), muted(_('还没装')));
				row(_('访问地址'), muted(_('装好后 http://<路由器IP>:<端口>')));
			}

			row(_('端口'), st.port || '—');
			row(_('数据目录'), E('code', {}, [ st.datadir || '—' ]));
			row(_('账号数'), [
				E('code', {}, [ String(int(st.accounts)) ]),
				muted(' ' + _('个 JSON（在 accounts/ 下，四版共用）'))
			]);
			row(_('用量体积'), mb(st.usagesize_kb));
			row(_('数据盘剩余'), mb(st.data_free_kb));
			row(_('overlay 剩余'), mb(st.overlay_free_kb));
			if (flag(st.docker))
				row(_('Docker 剩余'), mb(st.docker_free_kb));

			if (busy(t.phase) || t.phase === 'error' || t.phase === 'done') {
				var cls = 'wb-task' + (t.phase === 'error' ? ' err' : (t.phase === 'done' ? ' ok' : ''));

				rows.push(E('div', { 'class': 'wb-c', 'style': 'grid-column:1 / -1; padding:0; border:0' }, [
					E('div', { 'class': cls }, [
						E('strong', {}, [ PHASE_TEXT[t.phase] || t.phase ]),
						t.detail ? E('span', {}, [ ' ' + t.detail ]) : '',
						t.phase === 'error'
							? E('div', { 'style': 'margin-top:.4rem' }, [
								muted(_('点「查看日志」看输出，日志文件 /var/run/workbuddy2api-task/log。'))
							])
							: ''
					])
				]));
			}

			var grid = E('div', { 'class': 'wb-grid' });
			rows.forEach(function(nodes) {
				[].concat(nodes).forEach(function(n) { grid.appendChild(n); });
			});

			clear(headWrap);
			headWrap.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'wb-wrap' }, [ grid ])
			]));
		}

		/* ---------------- 标签栏 ---------------- */
		function drawTabs(st) {
			clear(tabWrap);

			VARIANTS.forEach(function(v) {
				var tag = isPresent(st, v.id) ? _('（已装）') : '';
				var on = state.tab === v.id;

				tabWrap.appendChild(E('button', {
					'class': 'wb-tab' + (on ? ' on' : ''),
					'click': function(ev) {
						ev.preventDefault();
						state.tab = v.id;
						/* 用户自己点了就别再自动拉回已装的那一栏 */
						state.pinned = true;
						state.sig = '';
						drawAll(true);
					}
				}, [ v.title, tag ? E('span', { 'class': 'wb-tag' }, [ ' ' + tag ]) : '' ]));
			});
		}

		function warn(text) {
			return E('span', { 'class': 'wb-warn' }, [ text ]);
		}

		function taskBox(st) {
			var t = parseTask(st.task);

			if (!busy(t.phase) && t.phase !== 'error' && t.phase !== 'done')
				return null;

			var cls = 'wb-task' + (t.phase === 'error' ? ' err' : (t.phase === 'done' ? ' ok' : ''));

			return E('div', { 'class': cls, 'style': 'margin-top:1rem' }, [
				E('strong', {}, [ PHASE_TEXT[t.phase] || t.phase ]),
				t.detail ? E('span', {}, [ ' ' + t.detail ]) : ''
			]);
		}

		function otherInstalled(st, id) {
			for (var i = 0; i < KNOWN_KINDS.length; i++) {
				var k = KNOWN_KINDS[i];

				if (k !== id && isPresent(st, k))
					return k;
			}

			return null;
		}

		/* ---------------- 已装：操作区 ---------------- */
		function opsPane(st, v) {
			var inFlight = busy(parseTask(st.task).phase);
			var running = isRunning(st, v.id);
			var cur = verOf(st, v.id);
			var newv = latestOf(st, v.id);
			var canUpdate = newv && cur && vnum(newv) !== vnum(cur);
			var ops = [];

			if (canUpdate)
				ops.push(button(_('更新到 %s').format(newv), [ 'update', v.id ],
					{ primary: true, disabled: inFlight }));

			ops.push(running
				? button(_('停止'), [ 'stop', v.id ], { disabled: inFlight })
				: button(_('启动'), [ 'start', v.id ], { primary: true, disabled: inFlight }));
			ops.push(button(_('重启'), [ 'restart', v.id ], { disabled: inFlight }));
			ops.push(button(_('检查更新'), [ 'latest', 'all' ]));
			ops.push(button(_('查看日志'), [ 'logs', v.id ]));

			if (running && st.address)
				ops.push(E('a', {
					'class': 'btn cbi-button cbi-button-action',
					'href': st.address,
					'target': '_blank',
					'rel': 'noopener',
					'style': 'margin-right:.5rem;margin-bottom:.5rem'
				}, [ _('打开看板') ]));

			ops.push(button(_('卸载'), [ 'remove', v.id ], {
				danger: true,
				disabled: inFlight,
				confirm: _('会停掉并删除 %s 的程序，数据目录里的账号和用量保留。继续？').format(v.title)
			}));

			ops.push(button(_('卸载并删除数据'), [ 'remove', v.id, 'purge' ], {
				danger: true,
				disabled: inFlight,
				confirm: _('会把 %s 里的 accounts 和 usage 一起删掉，账号凭据全部丢失、不可恢复。继续？')
					.format(st.datadir || '')
			}));

			var info = [
				E('div', {}, [ _('实现'), ': ', v.how ]),
				E('div', {}, [ _('版本'), ': ', E('code', {}, [ cur ? 'v' + vnum(cur) : '—' ]) ])
			];

			if (v.id.indexOf('docker') > 0)
				info.push(E('div', {}, [ _('容器'), ': ', E('code', {}, [ 'wb-proxy' ]),
					muted(' ' + _('（host 网络，compose 文件在数据目录下）')) ]));
			else if (v.id === 'rust')
				info.push(E('div', {}, [ _('程序'), ': ', E('code', {}, [ '/usr/bin/wb-backend' ]) ]));
			else
				info.push(E('div', {}, [ _('程序'), ': ', E('code', {}, [ '/usr/lib/workbuddy2api' ]),
					muted(' ' + _('（官方包，apk/opkg 管理）')) ]));

			return E('div', { 'class': 'cbi-section wb-actions' }, [
				E('h3', {}, [ v.title ]),
				E('div', { 'class': 'cbi-map-descr' }, v.notes),
				E('div', { 'style': 'margin-top:1rem' }, info),
				E('div', { 'style': 'margin-top:1rem' }, ops),
				taskBox(st)
			]);
		}

		/* ---------------- 未装：安装栏 ---------------- */
		function installPane(st, v) {
			var inFlight = busy(parseTask(st.task).phase);
			var other = otherInstalled(st, v.id);
			var blocked = !!other;

			var fTag = E('input', {
				'type': 'text',
				'class': 'cbi-input-text',
				'placeholder': v.fieldHint
			});

			var btn = E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'disabled': (inFlight || blocked) ? 'disabled' : null
			}, [ inFlight ? _('进行中…') : _('安装 %s').format(v.title) ]);

			btn.addEventListener('click', function(ev) {
				ev.preventDefault();

				if (fDir.value.indexOf('/mnt/') !== 0) {
					ui.addNotification(null, E('p', {}, [
						_('数据目录必须在 /mnt 下：账号凭据、用量日志、容器数据都写这里')
					]), 'warning');
					return;
				}

				if (!/^[0-9]+$/.test(fPort.value)) {
					ui.addNotification(null, E('p', {}, [ _('端口必须是数字') ]), 'warning');
					return;
				}

				btn.disabled = true;
				btn.textContent = _('进行中…');

				return run([ 'install', v.id, fPort.value, fDir.value, fTag.value ],
					_('安装 %s').format(v.title));
			});

			var body = [
				E('h3', {}, [ v.title ]),
				E('div', { 'class': 'cbi-map-descr' }, [ v.how, E('br') ].concat(v.notes)),
				E('div', { 'class': 'wb-form', 'style': 'margin-top:1rem' }, [
					E('label', {}, [ v.fieldLabel ]), fTag,
					E('label', {}, [ _('装到哪里') ]),
					E('div', {}, [
						muted(v.id.indexOf('docker') > 0
							? _('容器 wb-proxy，镜像落在 docker 数据盘；账号与用量挂在下面那个数据目录。')
							: _('程序落在 overlay，数据在上面那个数据目录。'))
					])
				])
			];

			if (blocked) {
				var ov = variantOf(other);

				body.splice(2, 0, E('div', { 'class': 'wb-alert' }, [
					E('strong', {}, [ _('已经装了「%s」').format(ov ? ov.title : other) ]),
					E('div', { 'style': 'margin-top:.3rem' }, [
						_('四选一：同一时刻只能跑一个实现，装新的之前请先到「%s」标签页把它卸载。')
							.format(ov ? ov.title : other)
					])
				]));
			}

			if (v.id === 'python' && !flag(st.pkgpython))
				body.splice(2, 0, E('div', { 'class': 'wb-alert' }, [
					_('系统里没有 python3：安装时会从软件源拉 python3 等依赖（约 15MB），需要联网和可用的 opkg/apk 源。')
				]));

			body.push(E('div', { 'style': 'margin-top:1rem' }, [ btn ]));
			body.push(taskBox(st));

			return E('div', { 'class': 'cbi-section' }, body);
		}

		function drawPane(force) {
			var st = state.st;
			var v = variantOf(state.tab) || VARIANTS[0];
			var sig = [
				state.tab, st.kind, st.running, st.task,
				st.latest_python, st.latest_rust,
				st.python_present, st.python_docker_present,
				st.rust_present, st.rust_docker_present,
				st.python_version, st.python_docker_version,
				st.rust_version, st.rust_docker_version,
				flag(st.docker), flag(st.pkgpython), st.accounts
			].join('|');

			/* 用户正在表单里打字时不能被轮询重画，只有状态真变了才重建 */
			if (!force && sig === state.sig)
				return;

			state.sig = sig;

			var anyInstalled = st.kind && st.kind !== 'none';

			sharedWrap.style.display = anyInstalled ? 'none' : '';

			clear(paneWrap);
			paneWrap.appendChild(isPresent(st, state.tab) ? opsPane(st, variantOf(state.tab)) : installPane(st, variantOf(state.tab)));
		}

		function drawAll(force) {
			var st = state.st;
			var anyInstalled = st.kind && st.kind !== 'none';

			/* 已装的那一套不在当前标签上时切过去，免得在错的地方看状态。
			 * 用户手动点过标签就不再干预（否则永远翻不到别的栏看冲突提示）。
			 * 必须在 drawTabs 之前做，否则高亮还是旧标签。 */
			if (anyInstalled && !state.pinned && !isPresent(st, state.tab))
				state.tab = st.kind;

			drawHead(st);
			drawTabs(st);
			drawPane(force);
		}

		drawAll(true);

		poll.add(function() {
			return refresh(false);
		}, 8);

		return E('div', {}, [
			E('style', {}, [ CSS ]),
			E('h2', {}, [ _('WorkBuddy2API') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('把 WorkBuddy / CodeBuddy 的账号转成 OpenAI 兼容接口。四个版本任选一个装：'),
				_('本地·原版（Python）、容器·原版、本地·Rust（静态二进制）、容器·Rust。'),
				E('br'),
				_('四套共用同一个数据目录与端口，所以同一时刻只能跑一个；想换实现，先卸载再装，账号不用重新导入。')
			]),
			headWrap,
			sharedWrap,
			tabWrap,
			paneWrap,
			out
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
