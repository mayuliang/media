# 流媒体审核测试小程序 - 服务端


## 环境变量

* `HTTP_PORT` HTTP服务监听端口号。默认为8000

* `RTMP_PORT` RTMP服务监听端口号。默认为9000

* `HTTP_PREFIX` HTTP服务二级路径，默认为`/kfront-kmedia-review-demo-svc`

* `DB_DSN` 数据库连接DSN。如果忽略，默认建立本地Sqlite数据库

* `APP_SECRET` 微信API的AppSecret。如果忽略，则从配置文件`~/.kmedia-review-demo.conf`中读取

**注意** 微信API的AppSecret必须传递（无论是通过环境变量还是通过配置文件），否则启动过程会报错。


## 使用方法

### 安装依赖项

```bash
npm i
```

### 普通方式启动

```bash
node src/serve.js
# 或者
npm run start
```

### 以守护进程方式启动

```bash
npm run daemon
# 或者
npm run daemon-start
```

### 停止守护进程

```bash
npm run daemon-stop
```

### 重启守护进程

```bash
npm run daemon-restart
```

### 查看PM2日志

```bash
npm run log
```

### PM2进程管理

```bash
npm run pm2
```

