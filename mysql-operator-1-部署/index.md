# bitpoke/mysql-operator 技术解读系列 - 部署

---

## 命令

安装 mysql-operator 的操作命令在[官方仓库](https://github.com/bitpoke/mysql-operator#controller-deploy)和[官网](https://www.bitpoke.io/docs/mysql-operator/getting-started/)都有说明，具体安装命令如下：

```bash
## For Helm v3
helm repo add bitpoke https://helm-charts.bitpoke.io
helm install mysql-operator bitpoke/mysql-operator
```

在安装的chart包中，[values.yaml文件](https://github.com/bitpoke/mysql-operator/tree/master/deploy/charts/mysql-operator#readme)有些内容可以自定义配置。

- 如果想要在一个k8s集群里面启动多个mysql-operator，不想让不用operator互相干扰，就可以指定watchNamespace参数
- 如果k8s集群使用的storageClass不支持动态迁移，那么operator的replicaCount就得设置为3，否则节点挂掉后无法拉起新的pod
- 因为mysql高可用是基于orchestrator实现的，orchestrator又需要一个元数据库，元数据库的账号密码可以通过 orchestrator.topologyUser 和 orchestrator.topologyPassword 指定。topologyUser默认值是 orchestrator，如果密码不指定会随机生成
- (其他参数以后用到再说明)... ...

## 本地部署

- 添加 repo

```bash
$ helm repo add bitpoke https://helm-charts.bitpoke.io
```

- 安装 mysql-operator

安装之前先创建一个namespace，然后将mysql-operator安装到这个ns中

```bash
$ kubectl create namespace mysql
namespace/mysql created

$ helm install mysql-operator bitpoke/mysql-operator -n mysql
NAME: mysql-operator
LAST DEPLOYED: Fri Mar 17 18:53:26 2023
NAMESPACE: mysql
STATUS: deployed
REVISION: 1
TEST SUITE: None
NOTES:
You can create a new cluster by issuing:

cat <<EOF | kubectl apply -f-
apiVersion: mysql.presslabs.org/v1alpha1
kind: MysqlCluster
metadata:
  name: my-cluster
spec:
  replicas: 1
  secretName: my-cluster-secret
---
apiVersion: v1
kind: Secret
metadata:
  name: my-cluster-secret
type: Opaque
data:
  ROOT_PASSWORD: $(echo -n "not-so-secure" | base64)
EOF
```

执行成功后，可以用kubectl工具查询pod状态，直到Running

```bash
$ kubectl get all -n mysql
NAME                   READY   STATUS    RESTARTS   AGE
pod/mysql-operator-0   2/2     Running   1          3m11s

NAME                         TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)            AGE
service/mysql-operator       ClusterIP   10.102.117.142   <none>        80/TCP,9125/TCP    9m1s
service/mysql-operator-orc   ClusterIP   None             <none>        80/TCP,10008/TCP   9m1s

NAME                              READY   AGE
statefulset.apps/mysql-operator   1/1     9m1s
```

至此 mysql-operator 就算安装完成了。


## 资源解读

上述的安装流程步骤很简单，但是运行起来的mysql-operator对我们来说就是一个黑盒，下面通过执行 helm template 对其被安装的内容进行梳理。

### 梳理CRD

CRD 全程叫做 CustomResourceDefinition，详细信息可以从[官网](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)获取，这里不进行解释。

```bash
$ helm template mysql-operator bitpoke/mysql-operator -n mysql --include-crds | grep -A 20 CustomResourceDefinition | grep -e kind
kind: CustomResourceDefinition
    kind: MysqlBackup
kind: CustomResourceDefinition
    kind: MysqlCluster
kind: CustomResourceDefinition
    kind: MysqlDatabase
kind: CustomResourceDefinition
    kind: MysqlUser
```

从上面可以看到，安装mysql-operator的时候会创建4个CRD资源。从名称可以看出是分别是关于backup、cluster、database、user 相关的，也是本系列在后续篇章中要重点讲解的内容。

### 梳理其他资源

查看 mysql-operator 依赖的其他资源

```bash
$ helm template mysql-operator bitpoke/mysql-operator -n mysql | grep -e ^kind -e name | grep -A 1 ^kind
kind: ServiceAccount
  name: mysql-operator
--
kind: Secret
  name: mysql-operator-orc
--
kind: ConfigMap
  name: mysql-operator-orc
--
kind: ClusterRole
  name: mysql-operator
--
kind: ClusterRoleBinding
  name: mysql-operator
--
kind: Service
  name: mysql-operator-orc
--
kind: Service
  name: mysql-operator
--
kind: StatefulSet
  name: mysql-operator
```

从上可以看出，计算资源由StatefulSet管理，有2个Service资源，1个ConfigMap，1个Secret。其余3个是跟权限管理相关的配置。

接下来详细聊聊每个资源的作用。

### StatefulSet

helm install 安装时的内容如下：

```yaml
# Source: mysql-operator/templates/statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql-operator
  labels:
    helm.sh/chart: mysql-operator-0.6.2
    app.kubernetes.io/name: mysql-operator
    app.kubernetes.io/instance: mysql-operator
    app.kubernetes.io/version: "v0.6.2"
    app.kubernetes.io/managed-by: Helm
spec:
  replicas: 1
  serviceName: mysql-operator-orc
  podManagementPolicy: Parallel
  selector:
    matchLabels:
      app.kubernetes.io/name: mysql-operator
      app.kubernetes.io/instance: mysql-operator
  template:
    metadata:
      annotations:
        checksum/orchestrator-config: 301f994fcecde72ab6be4371173a860c68b440504210a400a8105c833311443b
        checksum/orchestrator-secret: 20304c64003f30460df7e5cdcc078d3bc55b882af412ed1d43ced6a765f1c160
      labels:
        app.kubernetes.io/name: mysql-operator
        app.kubernetes.io/instance: mysql-operator
    spec:
      serviceAccountName: mysql-operator
      securityContext:
        fsGroup: 65532
        runAsGroup: 65532
        runAsNonRoot: true
        runAsUser: 65532
      containers:
        - name: operator
          securityContext:
            {}
          image: "docker.io/bitpoke/mysql-operator:v0.6.2"
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080
              name: prometheus
              protocol: TCP
          env:
            - name: ORC_TOPOLOGY_USER
              valueFrom:
                secretKeyRef:
                  name: mysql-operator-orc
                  key: TOPOLOGY_USER
            - name: ORC_TOPOLOGY_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mysql-operator-orc
                  key: TOPOLOGY_PASSWORD
          args:
            - --leader-election-namespace=mysql
            - --orchestrator-uri=http://mysql-operator.mysql/api
            - --sidecar-image=docker.io/bitpoke/mysql-operator-sidecar-5.7:v0.6.2
            - --sidecar-mysql8-image=docker.io/bitpoke/mysql-operator-sidecar-8.0:v0.6.2
            - --failover-before-shutdown=true
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8081
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8081
          resources:
            {}
        - name: orchestrator
          securityContext:
            {}
          image: docker.io/bitpoke/mysql-operator-orchestrator:v0.6.2
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 3000
              name: http
              protocol: TCP
            - containerPort: 10008
              name: raft
              protocol: TCP
          env:
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
          envFrom:
            - prefix: ORC_
              secretRef:
                name: mysql-operator-orc
          volumeMounts:
            - name: data
              mountPath: /var/lib/orchestrator
            - name: config
              mountPath: /usr/local/share/orchestrator/templates
          livenessProbe:
            timeoutSeconds: 10
            initialDelaySeconds: 200
            httpGet:
              path: /api/lb-check
              port: 3000
          # https://github.com/github/orchestrator/blob/master/docs/raft.md#proxy-healthy-raft-nodes
          readinessProbe:
            timeoutSeconds: 10
            httpGet:
              path: /api/raft-health
              port: 3000
          resources:
            {}
      volumes:
        - name: config
          configMap:
            name: mysql-operator-orc
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ ReadWriteOnce ]
        resources:
          requests:
            storage: 1Gi
```

从描述中可以看到，一个pod里面会有两个container，分别启动 orchestrator 和 operator。

#### operator 容器

- 使用名字为 mysql-operator 的 serviceAccount 来做事件处理
- 声明 8080 的 prometheus 端口
- 在 livenessProbe 和 readinessProbe 里面出现了 8081 端口，但没有声明，所以只能 locahost 使用。
- 需要从 mysql-operator-orc secret 获取两个值当做自己的环境变量 ORC_TOPOLOGY_USER 和 ORC_TOPOLOGY_PASSWORD；
- 同时还有一些启动参数
```yaml
- --leader-election-namespace=mysql                                             # 如果安装时pod不是单副本，需要选主，这里是指定选主的ns
- --orchestrator-uri=http://mysql-operator.mysql/api                            # operator 为了和 orchestrator 通信
- --sidecar-image=docker.io/bitpoke/mysql-operator-sidecar-5.7:v0.6.2           # 5.7 版本的 mysql sidecar 镜像
- --sidecar-mysql8-image=docker.io/bitpoke/mysql-operator-sidecar-8.0:v0.6.2    # 8.0 版本的 mysql sidecar 镜像。因为 mysql 版本差异导致备份恢复的 xtrabackup 软件版本不同。
- --failover-before-shutdown=true
```

#### orchestrator 容器

- 声明 3000 的 http 服务端口
- 声明 10008 的 raft 消息同步端口
- 也需要从 mysql-operator-orc secret 获取值当做自己的环境变量
- 声明一个 volume 并挂载到 /var/lib/orchestrator(这里是为了存储 orchestrator 管理的元数据)
- 从 mysql-operator-orc configmap 获取配置并挂载到 /usr/local/share/orchestrator/templates(orchestrator启动的配置文件)

### ConfigMap

helm install 安装时的内容如下：

```yaml
# Source: mysql-operator/templates/orchestrator-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mysql-operator-orc
  labels:
    helm.sh/chart: mysql-operator-0.6.2
    app.kubernetes.io/name: mysql-operator
    app.kubernetes.io/instance: mysql-operator
    app.kubernetes.io/version: "v0.6.2"
    app.kubernetes.io/managed-by: Helm
data:
  orchestrator.conf.json: "{..........}"
  orc-topology.cnf: |
    [client]
    user = {{ .Env.ORC_TOPOLOGY_USER }}
    password = {{ .Env.ORC_TOPOLOGY_PASSWORD }}
```

在 StatefulSet 部分已经解释
- orchestrator.conf.json 是 orchestrator 启动需要使用的配置文件。
- orc-topology.cnf 是 orchestrator 访问数据库的账号密码。

配置信息如下（相关描述可以从[官网查阅](https://github.com/openark/orchestrator/blob/master/docs/configuration.md)）：

```bash
$ cat /usr/local/share/orchestrator/templates/orchestrator.conf.json
{
  "ApplyMySQLPromotionAfterMasterFailover": true,
  "BackendDB": "sqlite",
  "Debug": false,
  "DetachLostReplicasAfterMasterFailover": true,
  "DetectClusterAliasQuery": "SELECT CONCAT(SUBSTRING(@@hostname, 1, LENGTH(@@hostname) - 1 - LENGTH(SUBSTRING_INDEX(@@hostname,'-',-2))),'.',SUBSTRING_INDEX(@@report_host,'.',-1))",
  "DetectInstanceAliasQuery": "SELECT @@hostname",
  "DiscoverByShowSlaveHosts": false,
  "FailMasterPromotionIfSQLThreadNotUpToDate": true,
  "HTTPAdvertise": "http://{{ .Env.HOSTNAME }}.mysql-operator-orc:3000",
  "HostnameResolveMethod": "none",
  "InstancePollSeconds": 5,
  "ListenAddress": ":3000",
  "MasterFailoverLostInstancesDowntimeMinutes": 10,
  "MySQLHostnameResolveMethod": "@@report_host",
  "MySQLTopologyCredentialsConfigFile": "/etc/orchestrator/orc-topology.cnf",
  "OnFailureDetectionProcesses": [
    "/usr/local/bin/orc-helper event -w '{failureClusterAlias}' 'OrcFailureDetection' 'Failure: {failureType}, failed host: {failedHost}, lost replcas: {lostReplicas}' || true",
    "/usr/local/bin/orc-helper failover-in-progress '{failureClusterAlias}' '{failureDescription}' || true"
  ],
  "PostIntermediateMasterFailoverProcesses": [
    "/usr/local/bin/orc-helper event '{failureClusterAlias}' 'OrcPostIntermediateMasterFailover' 'Failure type: {failureType}, failed hosts: {failedHost}, slaves: {countSlaves}' || true"
  ],
  "PostMasterFailoverProcesses": [
    "/usr/local/bin/orc-helper event '{failureClusterAlias}' 'OrcPostMasterFailover' 'Failure type: {failureType}, new master: {successorHost}, slaves: {slaveHosts}' || true"
  ],
  "PostUnsuccessfulFailoverProcesses": [
    "/usr/local/bin/orc-helper event -w '{failureClusterAlias}' 'OrcPostUnsuccessfulFailover' 'Failure: {failureType}, failed host: {failedHost} with {countSlaves} slaves' || true"
  ],
  "PreFailoverProcesses": [
    "/usr/local/bin/orc-helper failover-in-progress '{failureClusterAlias}' '{failureDescription}' || true"
  ],
  "ProcessesShellCommand": "sh",
  "RaftAdvertise": "{{ .Env.HOSTNAME }}.mysql-operator-orc",
  "RaftBind": "{{ .Env.HOSTNAME }}",
  "RaftDataDir": "/var/lib/orchestrator",
  "RaftEnabled": true,
  "RaftNodes": [],
  "RecoverIntermediateMasterClusterFilters": [
    ".*"
  ],
  "RecoverMasterClusterFilters": [
    ".*"
  ],
  "RecoveryIgnoreHostnameFilters": [],
  "RecoveryPeriodBlockSeconds": 300,
  "RemoveTextFromHostnameDisplay": ":3306",
  "SQLite3DataFile": "/var/lib/orchestrator/orc.db",
  "SlaveLagQuery": "SELECT TIMESTAMPDIFF(SECOND,ts,UTC_TIMESTAMP()) as drift FROM sys_operator.heartbeat ORDER BY drift ASC LIMIT 1",
  "UnseenInstanceForgetHours": 1
}
```


### Secret

helm install 安装时的内容如下：

```yaml
# Source: mysql-operator/templates/orchestrator-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: mysql-operator-orc
  labels:
    helm.sh/chart: mysql-operator-0.6.2
    app.kubernetes.io/name: mysql-operator
    app.kubernetes.io/instance: mysql-operator
    app.kubernetes.io/version: "v0.6.2"
    app.kubernetes.io/managed-by: Helm
data:
  TOPOLOGY_USER: "b3JjaGVzdHJhdG9y"
  TOPOLOGY_PASSWORD: "aVdZZndhMzJHZw=="
```

从 key 可以看出这就是 orchestrator 需要的元数据账号密码信息，使用base64解析出原文

```yaml
$ echo 'b3JjaGVzdHJhdG9y' | base64 -d
orchestrator

$ echo 'aVdZZndhMzJHZw==' | base64 -d
iWYfwa32Gg
```


### Service

helm install 安装时的内容如下：

```yaml
# Source: mysql-operator/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: mysql-operator
  labels:
    helm.sh/chart: mysql-operator-0.6.2
    app.kubernetes.io/name: mysql-operator
    app.kubernetes.io/instance: mysql-operator
    app.kubernetes.io/version: "v0.6.2"
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/component: operator
spec:
  type: ClusterIP
  ports:
    - port: 80
      name: http
      protocol: TCP
      targetPort: http
    - port: 9125
      name: prometheus
      protocol: TCP
      targetPort: prometheus
  selector:
    app.kubernetes.io/name: mysql-operator
    app.kubernetes.io/instance: mysql-operator
---
# Source: mysql-operator/templates/orchestrator-raft-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: mysql-operator-orc
  labels:
    app.kubernetes.io/component: orchestrator-raft
    helm.sh/chart: mysql-operator-0.6.2
    app.kubernetes.io/name: mysql-operator
    app.kubernetes.io/instance: mysql-operator
    app.kubernetes.io/version: "v0.6.2"
    app.kubernetes.io/managed-by: Helm
spec:
  type: ClusterIP
  clusterIP: None
  publishNotReadyAddresses: true
  ports:
    - name: http
      port: 80
      targetPort: 3000
    - name: raft
      port: 10008
      targetPort: 10008
  selector:
    app.kubernetes.io/name: mysql-operator
    app.kubernetes.io/instance: mysql-operator
```

以上有2个service，虽然 type 都是 ClusterIP，但是 mysql-operator-orc 还有个 clusterIP: None，这个配置表示该 service 是个 Headless Service，不需要额外的 ip。

- mysql-operator-orc 有两个端口
    - 80：targetPort 是 3000，orchestrator 的[可视化页面和api服务接口](https://github.com/openark/orchestrator/blob/master/docs/configuration-backend.md)
    - 10008：targetPort 是 10008，这个端口是 orchestrator 多副本之前进行 [raft 消息同步使用](https://github.com/openark/orchestrator/blob/master/docs/raft.md)
- mysql-operator 也有两个端口
    - 80：targetPort 是 http，查询发现还是 orchestrator 的 3000 端口
    - 9125：targetPort 是 prometheus，prometheus 在 StatefulSet中被定义到了 operator 容器的 8080 端口，通过 `curl http://127.0.0.1:8080/metrics` 可以查看到 operator 的指标数据

### ServiceAccount、ClusterRole、ClusterRoleBinding

helm install 安装时的内容如下：

```yaml
# Source: mysql-operator/templates/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: mysql-operator
  labels:
    helm.sh/chart: mysql-operator-0.6.2
    app.kubernetes.io/name: mysql-operator
    app.kubernetes.io/instance: mysql-operator
    app.kubernetes.io/version: "v0.6.2"
    app.kubernetes.io/managed-by: Helm
---
# Source: mysql-operator/templates/clusterrole.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: mysql-operator
  labels:
    helm.sh/chart: mysql-operator-0.6.2
    app.kubernetes.io/name: mysql-operator
    app.kubernetes.io/instance: mysql-operator
    app.kubernetes.io/version: "v0.6.2"
    app.kubernetes.io/managed-by: Helm
rules:
- apiGroups:
    - apps
  resources:
    - statefulsets
  verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
- apiGroups:
    - batch
  resources:
    - jobs
  verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
- apiGroups:
    - coordination.k8s.io
  resources:
    - leases
  verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
- apiGroups:
    - ""
  resources:
    - configmaps
    - events
    - jobs
    - persistentvolumeclaims
    - pods
    - secrets
    - services
  verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
- apiGroups:
    - ""
  resources:
    - pods/status
  verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
- apiGroups:
    - mysql.presslabs.org
  resources:
    - mysqlbackups
  verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
- apiGroups:
    - mysql.presslabs.org
  resources:
    - mysqlclusters
    - mysqlclusters/status
  verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
- apiGroups:
    - mysql.presslabs.org
  resources:
    - mysqldatabases
    - mysqldatabases/status
  verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
- apiGroups:
    - mysql.presslabs.org
  resources:
    - mysqlusers
    - mysqlusers/status
  verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
- apiGroups:
    - policy
  resources:
    - poddisruptionbudgets
  verbs:
    - create
    - delete
    - get
    - list
    - patch
    - update
    - watch
---
# Source: mysql-operator/templates/clusterrolebinding.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: mysql-operator
  labels:
    helm.sh/chart: mysql-operator-0.6.2
    app.kubernetes.io/name: mysql-operator
    app.kubernetes.io/instance: mysql-operator
    app.kubernetes.io/version: "v0.6.2"
    app.kubernetes.io/managed-by: Helm
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: mysql-operator
subjects:
  - name: mysql-operator
    namespace: "mysql"
    kind: ServiceAccount
```

在这里要引入k8s一个重要的概念 RBAC(Role Base Access Control)，是一种权限控制机制，用于实现账户和权限的组合管理

- 通过 ClusterRole 来声明都能操作那些api；
- 通过 ServiceAccount 创建一个账户；
- 最后通过 ClusterRoleBinding 将两者绑定。

#### 补充

另外每次创建一个 sa 的时候都会生成一个对应的 token secret：

```bash
$ kubectl create namespace sa-test
namespace/sa-test created

$ kubectl create serviceaccount test
serviceaccount/test created

$ kubectl get secret -n sa-test
NAME                  TYPE                                  DATA   AGE
default-token-6mdbt   kubernetes.io/service-account-token   3      31s

$ kubectl get secret -n sa-test -o yaml
apiVersion: v1
items:
- apiVersion: v1
  data:
    ca.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUM1ekNDQWMrZ0F3SUJBZ0lCQURBTkJna3Foa2lHOXcwQkFRc0ZBREFWTVJNd0VRWURWUVFERXdwcmRXSmwKY201bGRHVnpNQjRYRFRJek1ETXhOekF5TlRrek1sb1hEVE16TURNeE5EQXlOVGt6TWxvd0ZURVRNQkVHQTFVRQpBeE1LYTNWaVpYSnVaWFJsY3pDQ0FTSXdEUVlKS29aSWh2Y05BUUVCQlFBRGdnRVBBRENDQVFvQ2dnRUJBT3lKCm1ScE51Q21tVGM5dXNKbVJGMEo0Umw1bElQeE1iM0psQ0dONGF5Ry9IZXFEcmJlZnFLMzZJWmFYZVhNbi9Zb0wKMkM3Mktmd1Z3UnJuUldmZkt6L3k0UFR1bkRVUHpNa1BOMloybVRmbENuRG1ENEVjdGk4SVVNeS81ZWtVZ0kvLwppaEh6MllrKzVLb1RISmozc1VrTFRyV2llc0E3WVV6WkZnTGRmZkU2Yjh1WVExSzZtTW1yeWtjSVdyTVJqNEMyCkZ1SjM2a1VqNEJWK1luRVRMNnAxb1FxZWJqa1I2dFZWajZvb25ZNmNHejBUc0JldE03M3FrRTBBUnBFVm1kb3cKSWY1MmVJN0U0WFBuNWtHQk9RZ3k1OE5tNHdzQmEvYTlIbEtCSUFMUm9vaDdyamhHbmpCT1ZtNnFMcDRjdUVkUwpqellONE9WdWtaQ2M1cGRLRVdNQ0F3RUFBYU5DTUVBd0RnWURWUjBQQVFIL0JBUURBZ0trTUE4R0ExVWRFd0VCCi93UUZNQU1CQWY4d0hRWURWUjBPQkJZRUZFME5mWDRsdnEyRjF3MXlVVElYSE5QNVRGSFVNQTBHQ1NxR1NJYjMKRFFFQkN3VUFBNElCQVFCcFQreWwxcVE0Rm5wRjBOait6aVIxR2dZNnRkOXFkMkVaVmdqZ0t3bE1RcDdXSnJQaAo0cnZYTEg5SnhzTmc5Vkx3dGd0YklBall1a1J6dmo0b0ZNWGZGSmZTWlFONDBZTVhIdUl6dXQvNDRKeGp1MTNWClVqWDgrYWNmVG82TzZmc2JYdFpDR1g4UzFxZWRLUDZnbEFhOEh3dTNNbmJiRHdHYjdrcW51Uk81bTN0Z1B1Rm8KVnZRbnhkYjdzNmNIMUo5SjV1bURjMjVONk9BOGVrRzFROVM5Mk9pZDF6aitGZXQrOE55ZFE1ZFBVbWFUazhzdQpMaERjQTJ2TURuR0FrbnFGWWZkWjc5ejJnNlhlY1BCNE1LV2Frd25kZ1NxU2dtOXJKenBNTDFkU0ZTWHpjaEJYCitNc1FPNm5yNkZBMytsbkhrS1BrTWhsYnl5WE91OWNOSkNIQQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==
    namespace: c2EtdGVzdA==
    token: ZXlKaGJHY2lPaUpTVXpJMU5pSXNJbXRwWkNJNklrcERWMGRFWmtZeFNGbGhPRTFLTkVwSVNsQm9ZVlZ0YXpaeVZYaE5TamRvY0RScE1qQnFTMWcwTlVraWZRLmV5SnBjM01pT2lKcmRXSmxjbTVsZEdWekwzTmxjblpwWTJWaFkyTnZkVzUwSWl3aWEzVmlaWEp1WlhSbGN5NXBieTl6WlhKMmFXTmxZV05qYjNWdWRDOXVZVzFsYzNCaFkyVWlPaUp6WVMxMFpYTjBJaXdpYTNWaVpYSnVaWFJsY3k1cGJ5OXpaWEoyYVdObFlXTmpiM1Z1ZEM5elpXTnlaWFF1Ym1GdFpTSTZJbVJsWm1GMWJIUXRkRzlyWlc0dE5tMWtZblFpTENKcmRXSmxjbTVsZEdWekxtbHZMM05sY25acFkyVmhZMk52ZFc1MEwzTmxjblpwWTJVdFlXTmpiM1Z1ZEM1dVlXMWxJam9pWkdWbVlYVnNkQ0lzSW10MVltVnlibVYwWlhNdWFXOHZjMlZ5ZG1salpXRmpZMjkxYm5RdmMyVnlkbWxqWlMxaFkyTnZkVzUwTG5WcFpDSTZJamMwTkdVeFpqRTJMVFU1TldRdE5HVTNOaTA0TldVMUxUUXlZamRoWm1aak1tSXhNQ0lzSW5OMVlpSTZJbk41YzNSbGJUcHpaWEoyYVdObFlXTmpiM1Z1ZERwellTMTBaWE4wT21SbFptRjFiSFFpZlEuYVhqcXFpMGItUS1nTFJnSC1TUTY2T2hWMS1MWjhVZjlTeGplcUpVY0paVDQyUTBtcVl3MUY0cTl0cEtqQmVDSEhadnJiUENzaUZTMkRPbEtXM3I0aDFYZmpYemg0eTIwUnBvT1ZnT2tYOGhUWnZ5Q1BnUnZXWHBvTjBVZWYtNFotQUF4aFRWRnVWRWdqX1MzZGpiMUhSSVlsVHR3T3pnaVVnRWxZVFJWVFRFcDFySFBqQngtQUp5RGd4WlNqeEZQNWtJbGNRRzVTemZKQ3BzUXN6OWN3OFFwX1JPUlJwcExGVmExZGJNcFZjcXMzZDNCYWw0UXhfbEg2MnF5cXo4M1Z5a2RoUjVwN1JSSm8yZEpnNVZlVF9UVTZLdmpON21Qa2ctdjJPd3hQNkdHX1BrVm9xWHhpR2M4VkloLTZWeDNCdkF5Q1Y4LTRMTnZVVWt1TS1udkpR
  kind: Secret
  metadata:
    annotations:
      kubernetes.io/service-account.name: default
      kubernetes.io/service-account.uid: 744e1f16-595d-4e76-85e5-42b7affc2b10
    creationTimestamp: "2023-03-18T03:38:19Z"
    name: default-token-6mdbt
    namespace: sa-test
    resourceVersion: "49219"
    uid: 2bb22dc9-ee0f-48f9-922e-11001d96b2d7
  type: kubernetes.io/service-account-token
kind: List
metadata:
  resourceVersion: ""
  selfLink: ""
```

使用时就是上面的 StatefulSet 用法，指定好 serviceAccountName

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql-operator
spec:
  template:
    spec:
      serviceAccountName: mysql-operator
      # ... ...
```

在运行起来后，查看pod描述，每个container都会有多一个volumeMount，并且可以看到 volume 的声明

```yaml
spec:
  containers:
  - name: operator
    # ... ...
    volumeMounts:
    - mountPath: /var/run/secrets/kubernetes.io/serviceaccount
      name: kube-api-access-s5f2h
      readOnly: true
    # ... ...
  volumes:
  - name: kube-api-access-s5f2h
    projected:
      defaultMode: 420
      sources:
      - serviceAccountToken:
          expirationSeconds: 3607
          path: token
      - configMap:
          items:
          - key: ca.crt
            path: ca.crt
          name: kube-root-ca.crt
      - downwardAPI:
          items:
          - fieldRef:
              apiVersion: v1
              fieldPath: metadata.namespace
            path: namespace
```

登录容器内部可以看到配置已经挂载

```bash
$ ls /var/run/secrets/kubernetes.io/serviceaccount
ca.crt     namespace  token
```

operator 启动时会从这个位置[读取配置](https://github.com/kubernetes/client-go/blob/release-14.0/rest/config.go#L451)然后初始化k8s-client。

这里不得不夸赞下k8s

- sa的获取的保存不用我们操心
- sa的存储路径不用我们管理
- sa配置载入的逻辑不用我们自己写

## 总结

至此，通过安装mysql-operator和分析chart初步了解了资源组成，后续文章我们进入到mysql-operator内部，看看原理是如何实现的。


