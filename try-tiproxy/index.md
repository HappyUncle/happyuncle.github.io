# TiProxy 尝鲜

---

## 说明

最近发现 tidb 有个 <https://github.com/pingcap/TiProxy> 仓库，抱着好奇的心态想试试这个组件的使用效果。于是按照文档的介绍在本地环境使用tiup做了一些实验，现在将实验过程和实验结果分享给大家。



## TiProxy介绍

官方README介绍的已经很清楚了，最重要的特性是在TiDB升级、重启、扩缩节点时候可以保证连接不断。牛！

> TiProxy is a database proxy that is based on TiDB. It keeps client connections alive while the TiDB server upgrades, restarts, scales in, and scales out.

此外还有一些特性

- **连接管理：** 当tidb节点重启或者关机后，在这个节点上建立的连接会迁移到其他实例上，这个动作对client是透明的，client无感知

- **负载均衡：** 新建连接会对后端tidb-server进行打分，然后进行多个tidb实例间的均衡

- **服务发现：** TiProxy 通过跟pd交互获取最新的tidb实例信息，当有新的tidb启动时，proxy会自动发现并迁移连接至此。



## 实验说明

使用tiup搭建下测试环境，启动1个pd、1个tikv、1个tidb-server、1个tiproxy，通过tiproxy连接数据库，测试case如下：

- 启动两个终端连接数据库，然后加1个tidb-server节点，看看client无感的负责均衡效果

- 上一步完成后，我们有了2个tidb-server，那么缩掉一个，看看proxy是怎么做到会话迁移的



## 启动集群

[查阅资料](https://docs.pingcap.com/tidb/stable/tidb-configuration-file#session-token-signing-cert-new-in-v640) 发现TiProxy仅支持v6.4.0及以后版本，所以使用tiup启动这个版本的集群。

1. tidb 和 tiproxy 使用 toekn 认证方式，所以生成一个证书

```
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes -keyout key.pem -out cert.pem -subj "/CN=example.com"
```

2. 准备配置文件 tidb.toml 和 tiproxy.yaml

```markdown
$ cat tidb.toml
graceful-wait-before-shutdown=10

[security]
auto-tls=true
session-token-signing-cert='/tmp/tiup/tiproxy/cert.pem'
session-token-signing-key='/tmp/tiup/tiproxy/key.pem'

$ cat tiproxy.yaml
[proxy]
require-backend-tls = false
```

3. 启动tidb

```markdown
tiup playground v6.4.0 --db 1 --kv 1 --pd 1 --tiflash 0 --without-monitor --db.config tidb.toml
```

4. 启动tiproxy

```markdown
tiup tiproxy:nightly --config tiproxy.yaml
```



## 实验

### 1、加节点自动负载均衡

集群启动后，使用两个终端连接proxy，然后执行show processlist可以看到对方的会话，说明连接到了一个tidb节点上

![image.png](https://tidb-blog.oss-cn-beijing.aliyuncs.com/media/image-1690636806576.png)

执行tiup添加一个tidb-server节点

```markdown
tiup playground scale-out --db 1
```

然后分别执行show processlit查询，发现每个终端看不到对方的会话了，说明各自连接到了一个tidb实例。

![image.png](https://tidb-blog.oss-cn-beijing.aliyuncs.com/media/image-1690637078056.png)

仔细查看发现其中一个连接的信息从127.0.0.1:53240变成了127.0.0.1:54328，也确实说明发生了重连接。

> 这里补充个说明：因为我测试的时候没有开启proxy协议，所以show processlist看到的host不是client真实的信息，是proxy和tidb建立连接的信息，tidb把proxy当成client出来了。

测试结果很好，负载均衡client无感。

### 2、缩节点会话自动迁移

在这个基础上，执行tiup缩掉一个tidb-server

```markdown
tiup playground scale-in --pid 91609
```

然后执行show processlist，可以看到对方的会话，说明又连接到了同一个tidb节点上。

![image.png](https://tidb-blog.oss-cn-beijing.aliyuncs.com/media/image-1690637671544.png)

执行sql的时候没有报错，client无感知。



## 加餐

实验至此一切都丝般顺滑、符合预期。但是测试的场景未免有些简单。下面做个带有事务的case：

使用tiup搭建下测试环境，启动1个pd、1个tikv、1个tidb-server、1个tiproxy，通过tiproxy连接数据库，打开两个终端并显示执行一个begin，然后分别执行个写入操作，之后再添加1个tidb-server，看看会话是否会被迁移。

![image.png](https://tidb-blog.oss-cn-beijing.aliyuncs.com/media/image-1690638507392.png)

这说明在执行中的事务不会做迁移。在[设计文档](https://github.com/pingcap/tidb/blob/master/docs/design/2022-07-20-session-manager.md#connection-state-maintenance) 中也的确有这样的描述

> Transactions are hard to be restored, so Session Manager doesn't support restoring a transaction. Session Manager must wait until the current transaction finishes or the TiDB instance exits due to shut down timeout.

符合预期。



## 总结

本次基于v6.4.0版本做了3个简单的实验，对于tidb节点扩缩有会话自动迁移的能力的确很丝滑。

整个过程cleint无报错、无感知。被迁移的会话如果有未提的事务，则会等到事务结束后再迁移。

赞👍🏻

