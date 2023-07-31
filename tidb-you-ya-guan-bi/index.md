# TiDB 优雅关闭


---



## 背景

今天使用tiup做实验的事后，将tidb节点从2个缩到1个，发现tiup返回成功但是tidb-server进程还在。

这就引发的我的好奇心，why？

## 实验复现

### 启动集群

```bash
#( 07/31/23@ 8:32下午 )( happy@ZBMAC-f298743e3 ):~/docker/tiup/tiproxy
   tiup playground v6.4.0 --db 2 --kv 1 --pd 1 --tiflash 0 --without-monitor --db.config tidb.toml
tiup is checking updates for component playground ...
Starting component `playground`: /Users/happy/.tiup/components/playground/v1.12.5/tiup-playground v6.4.0 --db 2 --kv 1 --pd 1 --tiflash 0 --without-monitor --db.config tidb.toml
Start pd instance:v6.4.0
Start tikv instance:v6.4.0
Start tidb instance:v6.4.0
Start tidb instance:v6.4.0
Waiting for tidb instances ready
127.0.0.1:4000 ... Done
127.0.0.1:4001 ... Done

🎉 TiDB Playground Cluster is started, enjoy!

Connect TiDB:   mysql --comments --host 127.0.0.1 --port 4000 -u root
Connect TiDB:   mysql --comments --host 127.0.0.1 --port 4001 -u root
TiDB Dashboard: http://127.0.0.1:2379/dashboard
```

### 查看节点信息

```bash
#( 07/31/23@ 8:32下午 )( happy@ZBMAC-f298743e3 ):~
   tiup playground display
tiup is checking updates for component playground ...
Starting component `playground`: /Users/happy/.tiup/components/playground/v1.12.5/tiup-playground display
Pid    Role  Uptime
---    ----  ------
10113  pd    49.376485092s
10114  tikv  49.32262974s
10115  tidb  49.283144092s
10116  tidb  49.245069308s
```

### 缩掉一个tidb节点

```bash
#( 07/31/23@ 8:34下午 )( happy@ZBMAC-f298743e3 ):~
   tiup playground scale-in --pid 10115
tiup is checking updates for component playground ...
Starting component `playground`: /Users/happy/.tiup/components/playground/v1.12.5/tiup-playground scale-in --pid 10115
scale in tidb success
```

这里可以看到已经返回了 scale in tidb success

### 查看进程

```bash
#( 07/31/23@ 8:34下午 )( happy@ZBMAC-f298743e3 ):~
   ps -ef | grep 10115
  502 11371 99718   0  8:34下午 ttys001    0:00.00 grep --color=auto --exclude-dir=.bzr --exclude-dir=CVS --exclude-dir=.git --exclude-dir=.hg --exclude-dir=.svn --exclude-dir=.idea --exclude-dir=.tox 10115
  502 10115 10111   0  8:32下午 ttys005    0:04.29 /Users/happy/.tiup/components/tidb/v6.4.0/tidb-server -P 4000 --store=tikv --host=127.0.0.1 --status=10080 --path=127.0.0.1:2379 --log-file=/Users/happy/.tiup/data/TlaeoSj/tidb-0/tidb.log --config=/Users/happy/.tiup/data/TlaeoSj/tidb-0/tidb.toml
```

进程还是存在

## 分析

于是查看了 v6.4.0 的 tidb-server 代码。首先想到去main函数看下close的流程

### main

```go
func main() {
    //..
    signal.SetupSignalHandler(func(graceful bool) {
        svr.Close()
        cleanup(svr, storage, dom, graceful)
        cpuprofile.StopCPUProfiler()
        close(exited)
    })
    // ...
}
```

在这里发现两个重要的逻辑 svr.Close()，cleanup(svr, storage, dom, graceful)

### svr.Close()

```go
// Close closes the server.
func (s *Server) Close() {
	s.startShutdown()
	s.rwlock.Lock() // prevent new connections
	defer s.rwlock.Unlock()

	if s.listener != nil {
		err := s.listener.Close()
		terror.Log(errors.Trace(err))
		s.listener = nil
	}
	if s.socket != nil {
		err := s.socket.Close()
		terror.Log(errors.Trace(err))
		s.socket = nil
	}
	if s.statusServer != nil {
		err := s.statusServer.Close()
		terror.Log(errors.Trace(err))
		s.statusServer = nil
	}
	if s.grpcServer != nil {
		s.grpcServer.Stop()
		s.grpcServer = nil
	}
	if s.autoIDService != nil {
		s.autoIDService.Close()
	}
	if s.authTokenCancelFunc != nil {
		s.authTokenCancelFunc()
	}
	s.wg.Wait()
	metrics.ServerEventCounter.WithLabelValues(metrics.EventClose).Inc()
}

func (s *Server) startShutdown() {
	s.rwlock.RLock()
	logutil.BgLogger().Info("setting tidb-server to report unhealthy (shutting-down)")
	s.inShutdownMode = true
	s.rwlock.RUnlock()
	// give the load balancer a chance to receive a few unhealthy health reports
	// before acquiring the s.rwlock and blocking connections.
	waitTime := time.Duration(s.cfg.GracefulWaitBeforeShutdown) * time.Second
	if waitTime > 0 {
		logutil.BgLogger().Info("waiting for stray connections before starting shutdown process", zap.Duration("waitTime", waitTime))
		time.Sleep(waitTime)
	}
}
```

从上面的逻辑可以看到，close的时候先startShutdown再进行资源回收。而在执行startShutdown的时候，居然有个time.Sleep(waitTime)。

然后研究下 [graceful-wait-before-shutdown](https://docs.pingcap.com/zh/tidb/v6.5/tidb-configuration-file#graceful-wait-before-shutdown-%E4%BB%8E-v50-%E7%89%88%E6%9C%AC%E5%BC%80%E5%A7%8B%E5%BC%95%E5%85%A5) 参数，发现参数是0，不是此处导致的。

> 在 TiDB 等待服务器关闭期间，HTTP 状态会显示失败，使得负载均衡器可以重新路由流量
> 默认值：0
> 指定关闭服务器时 TiDB 等待的秒数，使得客户端有时间断开连接。

### cleanup()

在 cleanup 中看到了 GracefulDown 和 TryGracefulDown 两个方法

```go
func cleanup(svr *server.Server, storage kv.Storage, dom *domain.Domain, graceful bool) {
	if graceful {
		done := make(chan struct{})
		svr.GracefulDown(context.Background(), done)
	} else {
		svr.TryGracefulDown()
	}
	plugin.Shutdown(context.Background())
	closeDomainAndStorage(storage, dom)
	disk.CleanUp()
	topsql.Close()
}
```

#### TryGracefulDown

研究发现使用 SIGHUP 终止进程时使用 TryGracefulDown 方法，其他时候使用 GracefulDown。对比 TryGracefulDown 和 GracefulDown 实现， TryGracefulDown 只是多个15s的超时处理，底层逻辑还是 GracefulDown

```go
var gracefulCloseConnectionsTimeout = 15 * time.Second

// TryGracefulDown will try to gracefully close all connection first with timeout. if timeout, will close all connection directly.
func (s *Server) TryGracefulDown() {
	ctx, cancel := context.WithTimeout(context.Background(), gracefulCloseConnectionsTimeout)
	defer cancel()
	done := make(chan struct{})
	go func() {
		s.GracefulDown(ctx, done)
	}()
	select {
	case <-ctx.Done():
		s.KillAllConnections()
	case <-done:
		return
	}
}
```

#### GracefulDown

下面是 GracefulDown 实现，原来在这里会间隔1s，一直判断客户端连接是否存在，如果不存在才退出。

```go
// GracefulDown waits all clients to close.
func (s *Server) GracefulDown(ctx context.Context, done chan struct{}) {
	logutil.Logger(ctx).Info("[server] graceful shutdown.")
	metrics.ServerEventCounter.WithLabelValues(metrics.EventGracefulDown).Inc()

	count := s.ConnectionCount()
	for i := 0; count > 0; i++ {
		s.kickIdleConnection()

		count = s.ConnectionCount()
		if count == 0 {
			break
		}
		// Print information for every 30s.
		if i%30 == 0 {
			logutil.Logger(ctx).Info("graceful shutdown...", zap.Int("conn count", count))
		}
		ticker := time.After(time.Second)
		select {
		case <-ctx.Done():
			return
		case <-ticker:
		}
	}
	close(done)
}
```

#### ConnectionCount

判断连接个数的逻辑也很简单，就是对算下 s.clients 的 length

```go
// ConnectionCount gets current connection count.
func (s *Server) ConnectionCount() int {
	s.rwlock.RLock()
	cnt := len(s.clients)
	s.rwlock.RUnlock()
	return cnt
}
```

其中还有一个奇怪的函数 kickIdleConnection，这个是做什么的？

#### kickIdleConnection

看逻辑是收集可以被close的会话然后close掉。

```go
func (s *Server) kickIdleConnection() {
	var conns []*clientConn
	s.rwlock.RLock()
	for _, cc := range s.clients {
		if cc.ShutdownOrNotify() {
			// Shutdowned conn will be closed by us, and notified conn will exist themselves.
			conns = append(conns, cc)
		}
	}
	s.rwlock.RUnlock()

	for _, cc := range conns {
		err := cc.Close()
		if err != nil {
			logutil.BgLogger().Error("close connection", zap.Error(err))
		}
	}
}
```

那么什么样的会话可以被close呢？

#### ShutdownOrNotify

有三类：

- client 状态处于 ServerStatusInTrans；
- 状态处于 connStatusReading
- 以及处于 connStatusDispatching 在 clientConn.Run 方法中被回收

```go
// ShutdownOrNotify will Shutdown this client connection, or do its best to notify.
func (cc *clientConn) ShutdownOrNotify() bool {
	if (cc.ctx.Status() & mysql.ServerStatusInTrans) > 0 {
		return false
	}
	// If the client connection status is reading, it's safe to shutdown it.
	if atomic.CompareAndSwapInt32(&cc.status, connStatusReading, connStatusShutdown) {
		return true
	}
	// If the client connection status is dispatching, we can't shutdown it immediately,
	// so set the status to WaitShutdown as a notification, the loop in clientConn.Run
	// will detect it and then exit.
	atomic.StoreInt32(&cc.status, connStatusWaitShutdown)
	return false
}

const (
	connStatusDispatching int32 = iota
	connStatusReading
	connStatusShutdown     // Closed by server.
	connStatusWaitShutdown // Notified by server to close.
)
```


## 破案

通过上面的分析，我们注意到了处于 ServerStatusInTrans 状态的连接不会被关闭，然后连接该节点执行show processlist发现的确有个处于事务中的会话

```mysql
mysql> show processlist;
+---------------------+------+-----------------+------+---------+------+----------------------------+------------------+
| Id                  | User | Host            | db   | Command | Time | State                      | Info             |
+---------------------+------+-----------------+------+---------+------+----------------------------+------------------+
| 7794237818187809175 | root | 127.0.0.1:61293 | a    | Query   |    0 | in transaction; autocommit | show processlist |
+---------------------+------+-----------------+------+---------+------+----------------------------+------------------+
1 row in set (0.00 sec)

```

平时mysql使用的多，mysql在关闭的时候不管会话处于什么阶段，不管不顾直接停服，而tidb的这样处理着实让我想不到。

## 总结

本文简短的分析了下 tidb 进程关闭的处理流程，最终定位到进程没有及时关闭的原因。

对比于mysql的停服行为，让我们对tidb的处理方式有了不一样的理解。

对于 “graceful-wait-before-shutdown 参数”、“停服时等待事务结束的逻辑”的确需要在实践中才能积累。


