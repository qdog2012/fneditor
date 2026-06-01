# FnCode

一个适合部署在 fnOS / 飞牛 NAS 的 Web 代码编辑器。界面采用 VSCode 风格，左侧目录列表，右侧文件内容。

## 本地开发

```bash
npm install
npm run dev
```

默认监听 `http://localhost:8080`。开发时可用环境变量指定文件根目录：

```bash
FNEDITOR_ROOT=/path/to/my/files npm run dev
```

Windows PowerShell 可使用：

```powershell
$env:FNEDITOR_ROOT="D:\my-files"; npm run dev
```

生产模式：

```bash
npm run build
npm run start:prod
```

## 飞牛部署

容器默认读取 `/data`，建议把当前用户的“我的文件”或需要编辑的目录挂载到容器 `/data`：

```yaml
services:
  fneditor:
    build: .
    container_name: fneditor
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - FNEDITOR_ROOT=/data
    volumes:
      - /vol1/1000:/data
```

如果你的“我的文件”实际路径不是 `/vol1/1000`，把 compose 里的左侧宿主路径改成飞牛文件管理器复制出来的实际路径即可。

## 原生 FPK 打包

如果不想用 Docker，可以按 `packaging/fpk-native` 做原生 `.fpk` 包。这个方式会把 Linux Node.js 运行时、后端服务、前端静态文件和生产依赖一起放进包里。

在 Linux 或 fnOS 打包环境中执行：

```bash
bash scripts/prepare-fpk-native.sh
```

脚本会生成 `build/fpk-native/fneditor` staging 目录。随后使用飞牛 `fnpack` 或 Fnpackup 从该目录生成 `.fpk`。

如果在 WSL 中从 `/mnt/c`、`/mnt/d` 这类 Windows 挂载目录执行脚本，脚本会自动把源码复制到 `~/.cache/fneditor-fpk-src` 后再安装依赖，避免 Windows `node_modules` 和 Linux 原生依赖混用导致 `npm ci` 失败。

原生 FPK 默认把可编辑根目录放在应用数据目录下的 `files`，安装后可在设置中改成实际“我的文件”路径。最后应用的根目录会保存到应用状态文件中，服务重启后自动恢复。

## 功能

- 左侧文件资源管理器默认显示根目录文件列表
- 点击文件后在 Monaco 编辑器中打开
- `Ctrl+S` / `Cmd+S` 保存
- 新建文件、新建文件夹、刷新文件树
- 搜索当前根目录内的文件名和文本内容
- 在设置里调整编辑器字号、自动换行和主题
- 文件树右键菜单支持打开、新建、重命名、复制路径、刷新、删除
- 编辑器标签右键菜单支持保存、关闭、关闭其他、定位到资源管理器
- 多标签打开文件，未保存状态提示
- 后端限制所有读写都在 `FNEDITOR_ROOT` 内，避免越界访问
