# How to Run


# 安装最新版go

[https://www.runoob.com/go/go-environment.html](https://www.runoob.com/go/go-environment.html)


# 安装hugo

[https://github.com/gohugoio/hugo](https://github.com/gohugoio/hugo)

```bash
CGO_ENABLED=1 go install --tags extended github.com/gohugoio/hugo@latest
```


# 新建私有仓库并初始化

新建私有仓库 [https://github.com/xxx/xxx](https://github.com/xxx/xxx)

```bash
git clone https://github.com/xxxx/xxx
cd xxxx
hugo new site . --force
```


# 更新主题

```bash
git submodule add https://github.com/HEIGE-PCloud/DoIt.git themes/DoIt
echo 'theme = "DoIt"' >> config.toml
```


## 更多配置

[https://hugodoit.pages.dev/zh-cn/theme-documentation-basics/](https://hugodoit.pages.dev/zh-cn/theme-documentation-basics/#创建你的项目)

### (非必须)开启评论

https://giscus.app/zh-CN

```yaml
[params.page.comment.giscus]
  enable = true
  # owner/repo
  dataRepo = "xxxx/xxxx.github.io"
  dataRepoId = "xxxx"
  dataCategory = "Announcements"
  dataCategoryId = "xxxxx"
  dataMapping = "pathname"
  dataReactionsEnabled = "1"
  dataEmitMetadata = "0"
  dataInputPosition = "top"
  lightTheme = "light"
  darkTheme = "dark"
  dataLang = "en"
```

# 新建文章

```bash
hugo new posts/how-to-run.md
vim content/posts/how-to-run.md
```


# 运行看效果

> 默认情况下, 所有文章和页面均作为草稿创建. 如果想要渲染这些页面, 请从元数据中删除属性 draft: true, 设置属性 draft: false 或者为 hugo 命令添加 -D/--buildDrafts 参数.

> 由于本主题使用了 Hugo 中的 .Scratch 来实现一些特性, 非常建议你为 hugo server 命令添加 --disableFastRender 参数来实时预览你正在编辑的文章页面.

> hugo serve 的默认运行环境是 development, 而 hugo 的默认运行环境是 production. 由于本地 development 环境的限制, 评论系统, CDN 和 fingerprint 不会在 development 环境下启用. 你可以使用 hugo serve -e production 命令来开启这些特性.

```bash
hugo server -D --disableFastRender -e production
```


# 配置github action 实现提交同步到主页

## 配置 api token

[https://zhuanlan.zhihu.com/p/568764664](https://zhuanlan.zhihu.com/p/568764664)

在私有仓库中配置 PERSONAL_TOKEN

## 新建个人主页

[https://github.com/xxxx/xxx.github.io](https://github.com/xxx/xxx.github.io)

## 添加 workflow

vim .github/workflows/gh-pages.yml

```yaml
name: GitHub Pages

on:
  push:
    branches:
      - main  # Set a branch to deploy
  pull_request:

jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: ${{ github.workflow }}-${{ github.ref }}
    steps:
      - uses: actions/checkout@v3
        with:
          submodules: true  # Fetch Hugo themes (true OR recursive)
          fetch-depth: 0    # Fetch all history for .GitInfo and .Lastmod

      - name: Setup Hugo
        uses: peaceiris/actions-hugo@v2
        with:
          hugo-version: '0.111.1'
          extended: true

      - name: Build
        run: hugo --minify

      - name: Deploy
        uses: peaceiris/actions-gh-pages@v3
        if: ${{ github.ref == 'refs/heads/main' }}
        with:
          external_repository: xxx/xxx.github.io
          publish_dir: ./public
          publish_branch: gh-page
          personal_token: ${{ secrets.PERSONAL_TOKEN }}
          commit_message: ${{ github.event.head_commit.message }}
```

## 推送代码等待效果

```bash
git add .
git commit -m "add workflow"
git push
```

