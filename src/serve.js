// serve

const
	Assert = require('assert'),
	Crypto = require('crypto'),
	Fs = require('fs'),
	Path = require('path'),
	Escape = require('escape-html'),
	Koa = require('koa'),
	KoaRouter = require('koa-router'),
	KoaBodyParser = require('koa-bodyparser'),
	Request = require('request-promise-native'),
	Sequelize = require('sequelize'),
	Sqlite = require('sqlite3'),
	{ NodeMediaServer } = require('node-media-server')
;

const
	// 配置文件地址
	CONFIG_FILE = './config/media.conf',
	// 数据库文件地址
	SQLITE_FILE = './data/kmedia.db',
	// 微信AppId和AppSecret
	APP_ID = 'wx59cbd5aa386c46d1',
	// HTTP接口监听地址
	HTTP_PORT = process.env['HTTP_PORT'] || 8000,
	// RTMP服务器的监听端口
	RTMP_PORT = process.env['RTMP_PORT'] || 9000,
	// HTTP服务二级路径
	HTTP_PREFIX = process.env['HTTP_PREFIX'] || '/kfront-kmedia-review-demo-svc',
	// 数据库连接选项
	DB_OPTIONS = {
		pool: {
			max: 16,
			min: 2
		}
	},
	// 用户数据结构
	MODEL_USER = {
		// 数字ID
		id: {
			type: Sequelize.INTEGER,
			allowNull: false,
			autoIncrement: true,
			primaryKey: true
		},
		// 数据ID
		uid: {
			type: Sequelize.STRING,
			allowNull: false,
			unique: true
		},
		// 用户姓名
		name: {
			type: Sequelize.STRING,
			allowNull: false
		}
	},
	// 家访数据结构
	MODEL_VISIT = {
		// 数字ID
		id: {
			type: Sequelize.INTEGER,
			allowNull: false,
			autoIncrement: true,
			primaryKey: true
		},
		// 数据ID
		uid: {
			type: Sequelize.STRING,
			allowNull: false,
			unique: true
		},
		// 老师的用户ID
		teacherUid: {
			type: Sequelize.STRING,
			allowNull: false
		},
		// 老师姓名
		teacher: {
			type: Sequelize.STRING,
			allowNull: false
		},
		// 学生姓名
		student: {
			type: Sequelize.STRING,
			allowNull: false
		},
		// 是否已准备
		isReady: {
			type: Sequelize.BOOLEAN,
			allowNull: false,
			defaultValue: false
		},
		// 是否正在进行
		isOngoing: {
			type: Sequelize.BOOLEAN,
			allowNull: false,
			defaultValue: false
		},
		// 是否已结束
		isFinished: {
			type: Sequelize.BOOLEAN,
			allowNull: false,
			defaultValue: false
		},
		// 开始时间戳（秒）
		startedAt: {
			type: Sequelize.INTEGER,
			allowNull: false,
			defaultValue: 0
		},
		// 持续时间（秒）
		duration: {
			type: Sequelize.INTEGER,
			allowNull: false,
			defaultValue: 0
		},
		// 结束时间戳（秒）
		finishedAt: {
			type: Sequelize.INTEGER,
			allowNull: false,
			defaultValue: 0
		}
	},
	// 预定义值：错误等级
	D_ERROR_FATAL = 1,
	D_ERROR_INPUT = 2,
	D_ERROR_RECOVERABLE = 3,
	// 预定义值：用户是否已注册
	D_REGISTERED_NO = 0,
	D_REGISTERED_YES = 1,
	// 预定义值：用户类型
	D_USER_TYPE_TEACHER = 1,
	D_USER_TYPE_STUDENT = 2,
	// 预定义值：家访状态
	D_VISIT_STATUS_INITIAL = 0,
	D_VISIT_STATUS_FINISHED = 1
;

let
	// 用户模型类
	User = null,
	// 家访模型类
	Visit = null
;

let
	// 微信AppSecret
	_appSecret = '';
	// 数据库连接DSN
	_dbDsn = '',
	// 数据库连接实例
	_connection = null;
	// Cache实例：管理会话
	_sessions = null,
	// Cache实例：管理家访分享Token
	_tokens = null
;

// 生成HEX格式的唯一ID
function genUid(size = 16) {
	return Crypto.randomBytes(size).toString('hex');
}

// 校验：失败则抛出错误等级1
function assertFatal(value, message, status) {
	if (!value) {
		throw new RequestError(D_ERROR_FATAL, message, status);
	}
}

// 校验：失败则抛出错误等级2
function assertInput(value, message, status) {
	if (!value) {
		throw new RequestError(D_ERROR_INPUT, message, status);
	}
}

// 校验：失败则抛出错误等级3
function assertRecoverable(value, message, status) {
	if (!value) {
		throw new RequestError(D_ERROR_RECOVERABLE, message, status);
	}
}

// 封装返回数据
function respond(data = {}) {
	return Object.assign({
		errLevel: 0,
		errMsg: ''
	}, data);
}

// 根据家访ID创建家访Token
function createVisitToken(visitId) {
	let token = genUid();
	_tokens.set(token, visitId);
	return token;
}

// 根据家访Token获取家访ID
function getVisitId(token) {
	let visitId = _tokens.get(token);
	return visitId;
}

// 便利函数：针对单个家访数据接口的数据校验及查询操作
async function filter1(ctx, fields, body = null) {

	let sessionId = ctx.state.sessionId;
	let {
		id
	} = body || ctx.request.body;
	assertFatal(Session.has(sessionId), '无效的会话');
	assertInput(id, '无效的ID值');

	let visit = await Visit.findOne({
		where: {
			uid: id
		},
		attributes: fields
	});
	if (!visit) {
		throw new RequestError(D_ERROR_INPUT, '指定的数据不存在', 404);
	}

	return visit;
}

// 加载相关配置
async function loadConfig() {

	_appSecret = process.env['APP_SECRET'];
	if (!_appSecret) {
		let configFile = Path.resolve(CONFIG_FILE.replace('~', process.env['HOME']));
		let configData = Fs.readFileSync(configFile, 'utf8');
		let config = JSON.parse(configData);

		if (!config.appSecret) {
			throw new Error(`Missing config entry 'appSecret'`);
		}
		_appSecret = config.appSecret;
	}

	_dbDsn = process.env['DB_DSN'];
	if (!_dbDsn) {
		let sqliteFile = Path.resolve(__dirname, '..', SQLITE_FILE);
		try {
			Fs.mkdirSync(Path.dirname(sqliteFile));
		} catch (err) {
		}
		let sqlite = await new Promise((resolve, reject) => {
			let obj = new Sqlite.Database(sqliteFile, (err) => {
				if (err) {
					return reject(err);
				}
				resolve(obj);
			});
		});
		await new Promise((resolve, reject) => {
			sqlite.close((err) => {
				if (err) {
					return reject(err);
				}
				resolve();
			});
		});
		_dbDsn = `sqlite:${sqliteFile}`;
	}
}

// 连接到数据库
async function dbConnect() {

	if (!_connection) {
		_connection = new Sequelize(_dbDsn, DB_OPTIONS);
		await _connection.authenticate();
		console.log(`Database connected`);
		User = _connection.define('user', MODEL_USER, {
			freezeTableName: true
		});
		Visit = _connection.define('visit', MODEL_VISIT, {
			freezeTableName: true
		});
		await _connection.sync();
	}

	return _connection;
}

// 初始化数据库状态
async function dbInit() {
	// 针对服务器重启的情况：充值所有状态为已准备和正在家访的数据
	await _connection.query(`UPDATE visit SET isReady = 0, isOngoing = 0`);
}

// 用户错误类
const RequestError = class extends Error {

	constructor(level, message = '未知错误', statusCode = 400) {
		super(message);
		this.level = level;
		this.message = message;
		this.statusCode = statusCode;
	}

	toBody() {
		return {
			errLevel: this.level,
			errMsg: this.message
		};
	}
}

// Cache类
const Cache = class {

	constructor() {
		this.cache = {};
		this.expires = {};
		this.interval = 60000;
		this.handle = null;
	}

	has(key) {
		return this.cache.hasOwnProperty(key);
	}

	get(key) {
		return this.cache[key];
	}

	set(key, value, expire = 0) {
		if (Object.prototype.toString.call(key) === '[object Object]') {
			for (let k in key) {
				this.set(k, key[k], value);  // value as expire
				this.expire(k, expire);
			}
			return;
		}
		this.cache[key] = value;
		this.expire(key, expire);
	}

	del(key) {
		delete this.cache[key];
		delete this.expires[key];
	}

	expire(key, expire = 0) {
		if (isNaN(Number(expire))) {
			throw new Error(`The expiration must be a valid number: ${expire}`);
		}
		if (expire > 0) {
			this.expires[key] = Math.floor(Date.now() / 1000) + expire;
		} else {
			delete this.expires[key];
		}
	}

	validate() {
		let now = Math.floor(Date.now() / 1000);
		for (let key in this.expires) {
			let end = this.expires[key];
			if (end && end <= now) {
				this.del(key);
			}
		}
	}

	start() {
		this.handle = setInterval(() => {
			this.validate();
		}, this.interval);
	}

	stop() {
		clearInterval(this.handle);
	}
}

// 会话类
const Session = class Session extends Cache {

	static has(sessionId) {
		return sessionId && _sessions.has(sessionId);
	}

	static get(sessionId) {
		return _sessions.get(sessionId);
	}

	static create(sessionId) {
		let session = new Session(sessionId);
		_sessions.set(sessionId, session);
		return session;
	}

	constructor(sessionId) {
		super();
		this.id = sessionId;
	}
};

// 搭建HTTP接口服务
function setupHTTP() {

	_sessions = new Cache();
	_sessions.start();

	_tokens = new Cache();
	_tokens.start();

	// Router实例：wxapp
	let wxappRouter = new KoaRouter({
		prefix: HTTP_PREFIX
	});

	wxappRouter
		// 登陆验证
		.post('/login', async (ctx, next) => {
			let {
				code,
				token
			} = ctx.request.body;
			assertFatal(code, '无效的code参数');

			let json = await Request({
				method: 'GET',
				uri: 'https://api.weixin.qq.com/sns/jscode2session',
				qs: {
					appid: APP_ID,
					secret: _appSecret,
					js_code: code,
					grant_type: 'authorization_code'
				}
			});
			let {
				openid: openId,
				session_key: sessionKey
			} = JSON.parse(json);

			let sessionId = genUid();
			let uid = '';
			let name = '';
			let type;

			if (token) {  // student
				type = D_USER_TYPE_STUDENT;

				let visitId = getVisitId(token);
				assertFatal(visitId, '指定的家访不存在', 404);

				let visit = await Visit.findOne({
					where: {
						uid: visitId
					},
					attributes: [
						[ 'uid', 'id' ],
						'teacher',
						'student'
					]
				});
				if (!visit) {
					throw new RequestError(D_ERROR_INPUT, '指定的数据不存在', 404);
				}

				ctx.response.body = respond({
					sessionId,
					userInfo: {
						isRegistered: D_REGISTERED_NO,
						name,
						type
					},
					visitInfo: visit.get()
				});

			} else {  // teacher
				type = D_USER_TYPE_TEACHER;

				let user = await User.findOne({
					where: {
						uid: openId
					},
					attributes: [
						'uid',
						'name'
					]
				});

				if (!user) {  // new user
					ctx.response.body = respond({
						sessionId,
						userInfo: {
							isRegistered: D_REGISTERED_NO,
							name,
							type
						}
					});

				} else {  // login
					uid = user.uid;
					name = user.name;

					ctx.response.body = respond({
						sessionId,
						userInfo: {
							isRegistered: D_REGISTERED_YES,
							name,
							type
						}
					});
				}
			}

			Session.create(sessionId).set({
				openId,
				key: sessionKey,
				uid,
				name,
				type
			});
		})

		// 注册新用户
		.post('/signup', async (ctx, next) => {
			let sessionId = ctx.state.sessionId;
			let {
				name
			} = ctx.request.body;
			assertFatal(Session.has(sessionId), '无效的会话');
			assertInput(name, '用户名不能为空');

			let openId = Session.get(sessionId).get('openId');
			assertInput(openId, '会话失效，请重新打开小程序');

			let user = User.build({
				uid: openId,
				name: Escape(name)
			});
			await user.save();

			Session.get(sessionId).set({
				uid: openId,
				name: user.name
			});

			let type = Session.get(sessionId).get('type');
			ctx.response.body = respond({
				userInfo: {
					name: user.name,
					type
				}
			});
		})

		// 获取家访信息
		.get('/visit', async (ctx, next) => {
			let visit = await filter1(ctx, [
				'teacher',
				'student',
				'isReady',
				'isOngoing',
				'isFinished',
				'startedAt',
				'duration',
				'finishedAt'
			], ctx.request.query);

			ctx.response.body = respond({
				info: visit.get()
			});
		})

		// 获取家访列表
		.get('/visits', async (ctx, next) => {
			let sessionId = ctx.state.sessionId;
			let {
				status,
				offset,
				length
			} = ctx.request.query;
			status = Number(status);
			offset = Number(offset);
			length = Number(length);
			assertFatal(Session.has(sessionId), '无效的会话');
			assertFatal([ D_VISIT_STATUS_INITIAL, D_VISIT_STATUS_FINISHED ].includes(status), '无效的家访类型');
			assertFatal(offset >= 0, '无效的数据偏移量');
			assertFatal(length >= 0, '无效的数据查询量');
			assertInput(length <= 100, '单次查询的数据量不能超过100');

			let uid = Session.get(sessionId).get('uid');

			let visits = await Visit.findAll({
				where: {
					teacherUid: uid,
					isFinished: status
				},
				attributes: [
					[ 'uid', 'id' ],  // uid AS id
					'student',
					'isReady',
					'isOngoing',
					'isFinished',
					'startedAt',
					'duration',
					'finishedAt'
				],
				order: [
					[ 'isReady', 'desc' ],
					[ 'createdAt', 'desc' ]
				],
				offset,
				limit: length,
				raw: true
			});

			ctx.response.body = respond({
				list: visits
			});
		})

		// 预约家访
		.post('/schedule', async (ctx, next) => {
			let sessionId = ctx.state.sessionId;
			let {
				student
			} = ctx.request.body;
			assertFatal(Session.has(sessionId), '无效的会话');
			assertInput(student, '学生姓名不能为空');

			let teacherUid = Session.get(sessionId).get('uid');
			let teacher = Session.get(sessionId).get('name');
			let visitId = genUid();

			let visit = Visit.build({
				uid: visitId,
				teacherUid,
				teacher,
				student: Escape(student)
			});
			await visit.save();

			let token = createVisitToken(visitId);

			ctx.response.body = respond({
				token
			});
		})

		// 接受家访
		.post('/acceptVisit', async (ctx, next) => {
			let visit = await filter1(ctx, [
				'id',
				'uid',
				'isReady'
			]);
			let visitId = visit.uid

			visit.isReady = true;
			await visit.save();

			let teacherStream = `${visitId}-t`;
			let studentStream = `${visitId}-s`;
			ctx.response.body = respond({
				rtmpPort: RTMP_PORT,
				teacherStream,
				studentStream
			});
		})

		// 开始家访
		.post('/beginVisit', async (ctx, next) => {
			let visit = await filter1(ctx, [
				'id',
				'uid',
				'isReady',
				'isOngoing',
				'isFinished'
			]);
			let visitId = visit.uid;
			if (!visit.isReady) {
				throw new RequestError(D_ERROR_INPUT, '本次家访尚未准备好');
			}
			if (visit.isOngoing) {
				throw new RequestError(D_ERROR_INPUT, '本次家访正在进行中');
			}
			if (visit.isFinished) {
				throw new RequestError(D_ERROR_INPUT, '本次家访已结束');
			}

			visit.isOngoing = true;
			visit.startedAt = Math.floor(Date.now() / 1000);
			await visit.save();

			let teacherStream = `${visitId}-t`;
			let studentStream = `${visitId}-s`;
			ctx.response.body = respond({
				rtmpPort: RTMP_PORT,
				teacherStream,
				studentStream
			});
		})

		// 结束家访
		.post('/finishVisit', async (ctx, next) => {
			let visit = await filter1(ctx, [
				'id',
				'isReady',
				'isOngoing',
				'isFinished'
			]);

			visit.isReady = false;
			visit.isOngoing = false;
			visit.isFinished = true;
			visit.finishedAt = Math.floor(Date.now() / 1000);
			await visit.save();

			ctx.response.body = respond();
		})
	;

	// Router实例：admin
	let adminRouter = new KoaRouter({
		prefix: '/admin'
	});
	//TODO: admin apis

	let app = new Koa();

	// 中间件：错误捕捉
	app.use(async (ctx, next) => {
		try {
			await next();
		} catch (err) {
			if (err instanceof RequestError) {
				ctx.response.status = err.statusCode;
				ctx.response.body = err.toBody();
			} else {
				console.error(err);
				ctx.response.status = 500;
				ctx.response.body = err.message;
			}
			ctx.app.emit('error', err, ctx);
		}
	});
	// 中间件：解析请求Body
	app.use(KoaBodyParser());
	// 中间件：访问日志
	app.use(async (ctx, next) => {
		console.log(ctx.request.ip, ctx.request.method, ctx.request.url, ctx.request.body);
		ctx.state.sessionId = ctx.cookies.get('sessionId');
		console.log('SESSION', ctx.state.sessionId);
		await next();
		console.log(ctx.response.status, ctx.response.body);
	});
	// 中间件：CORS
	app.use(async (ctx, next) => {
		await next();
		ctx.response.set('Content-Type', 'application/json');
		ctx.response.set('Access-Control-Allow-Origin', '*');
	});
	// 中间件：wxapp接口
	app.use(wxappRouter.routes());
	// 中间件：admin接口
	app.use(adminRouter.routes());
	// 错误事件
	app.on('error', err => {
		console.error('Server error', err.message)
	});

	app.listen(HTTP_PORT, '0.0.0.0');

	console.log(`Starting HTTP server on port ${HTTP_PORT}`);
}

// 搭建RTMP服务
function setupRTMP() {
	let nms = new NodeMediaServer({
		rtmp: {
			port: RTMP_PORT,
			chunk_size: 65536,
			gop_cache: true,
			ping: 60,
			ping_timeout: 30
		}
		/*
		http: {
			port: 8000,
			allow_origin: '*'
		}
		*/
	});
	nms.on('preConnect', (id, args) => {
		console.log('[NodeEvent on preConnect]', `id=${id} args=${JSON.stringify(args)}`);
		// let session = nms.Session.get(id);
		// session.reject();
	});
	nms.on('postConnect', (id, args) => {
		console.log('[NodeEvent on postConnect]', `id=${id} args=${JSON.stringify(args)}`);
	});
	nms.on('doneConnect', (id, args) => {
		console.log('[NodeEvent on doneConnect]', `id=${id} args=${JSON.stringify(args)}`);
	});
	nms.on('prePublish', (id, StreamPath, args) => {
		console.log('[NodeEvent on prePublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
		// let session = nms.Session.get(id);
		// session.reject();
	});
	nms.on('postPublish', (id, StreamPath, args) => {
		console.log('[NodeEvent on postPublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
		// Steaming begin
		/*
		if (!!StreamPath && Object.keys(args).length > 0) {
			(async () => {
				let visitId = StreamPath.substr(6, StreamPath.length - 2);
				let side = visitStr.substr(StreamPath.length - 1);
				let visit = await Visit.findOne({
					where: {
						uid: visitId
					},
					attributes: [
						'isReady',
						'isOngoing'
					]
				});
				if (side === 't') {
					visit.isOngoing = true;
				} else if (side === 's') {
					visit.isReady = true;
				}
				await visit.save();
			})().catch((err) => {
				console.error(err);
			});
		}
		*/
	});
	nms.on('donePublish', (id, StreamPath, args) => {
		console.log('[NodeEvent on donePublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
		// Steaming end
		/*
		if (!!StreamPath && Object.keys(args).length > 0) {
			(async () => {
				let visitId = StreamPath.substr(6, StreamPath.length - 2);
				let side = visitStr.substr(StreamPath.length - 1);
				let visit = await Visit.findOne({
					where: {
						uid: visitId
					},
					attributes: [
						'isReady',
						'isOngoing'
					]
				});
				if (side === 't') {
					visit.isOngoing = false;
				} else if (side === 's') {
					visit.isReady = false;
				}
				await visit.save();
			})().catch((err) => {
				console.error(err);
			});
		}
		*/
	});
	nms.on('prePlay', (id, StreamPath, args) => {
		console.log('[NodeEvent on prePlay]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
		// let session = nms.Session.get(id);
		// session.reject();
	});
	nms.on('postPlay', (id, StreamPath, args) => {
		console.log('[NodeEvent on postPlay]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
		// Play begin
	});
	nms.on('donePlay', (id, StreamPath, args) => {
		console.log('[NodeEvent on donePlay]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
		// Play end
	});
	nms.run();
}

// 程序入口
function main() {

	(async () => {
		await loadConfig();
		await dbConnect();
		await dbInit();
		setupHTTP();
		setupRTMP();

	})().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

main();
