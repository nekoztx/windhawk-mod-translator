<div align="center">

# 🈶 Windhawk Mod 翻译器

**给 Windhawk 桌面客户端加上 Mod 介绍自动翻译（英文 → 简体中文）**

一键安装 · 无需网络代理 · 多翻译源自动切换 · 本地缓存

</div>

---

## ✨ 功能

- **Mod 详情页长篇介绍（README）自动翻译成中文**，打开即译
- Mod 卡片/详情页的英文短描述也会翻译（官方多语言目录未覆盖的部分）
- **翻译质量优先**：Google 翻译 → Bing 翻译 → MyMemory 自动降级，全部不可用时保持原文，绝不影响 Windhawk 原有功能
- **本地缓存**：翻过一次的内容不再重复请求
- **一键开关**：详情页右下角 `🌐 译` 按钮，随时开关（记住上次状态）
- 智能跳过：代码块、版本号、作者名、链接、已含中文的文本不翻译
- **幂等安装**：重复运行不会重复修改，Windhawk 升级后重新运行一次即可恢复

## 🚀 快速开始

1. 下载 [WindhawkModTranslator.exe](https://github.com/nekoztx/windhawk-mod-translator/releases/latest)（Release 资产）
2. **双击运行**（会请求管理员权限，因为要修改 `C:\Program Files\Windhawk` 下的文件）
3. 看到"安装完成"后，**完全退出 Windhawk**（托盘图标右键 → Exit）
4. 重新打开 Windhawk → 进入任意 Mod 的**"详 情"页** → 英文介绍几秒内自动变成中文 🎉

### 效果示例

| 位置 | 翻译前 | 翻译后 |
|---|---|---|
| 标题 | Taskbar Dock Animation | 任务栏停靠动画 |
| 正文 | This mod adds a macOS-like taskbar animation. | 这个 mod 添加了类似 macOS 的任务栏动画。 |
| 小节 | ⚠️ Known Issues & Limitations | ⚠️ 已知问题和限制 |
| 列表 | Icons are sometimes clipped by the taskbar. | 图标有时会被任务栏剪切。 |

## 📖 说明

- Windhawk 界面本身的汉化在 **设置 → 语言** 中切换（官方支持）；本工具只翻译 **Mod 介绍内容**
- 已安装 Mod 的**短描述**很多自带官方中文翻译（mod 作者提供的多语言元数据），本工具重点翻译更长的 **README 介绍**
- **需要网络**：翻译请求直连翻译服务。国内网络下 Google 不通时会自动改用 Bing/MyMemory
- 如果 "浏览 Mods" 页显示"加载失败，请检查您的网络连接"，那是 Windhawk 官方仓库（mods.windhawk.net）的网络问题，与本工具无关

## 🔄 更新（Windhawk 升级后）

Windhawk 升级会用自带文件覆盖修改，**重新运行一次 `WindhawkModTranslator.exe` 即可恢复**。

## 🗑️ 卸载

1. 删除 `C:\Program Files\Windhawk\UI\resources\app\extensions\windhawk\webview\translate.js`
2. 从安装器同目录的 `backup\` 中恢复原始文件：
   - `extension.js.<时间戳>.bak` → 复制为 `dist\extension.js`
   - `index.html.<时间戳>.bak` → 复制为 `webview\index.html`
3. 重启 Windhawk

## ⚙️ 工作原理

Windhawk 的界面其实是 VSCodium（Electron + VS Code）套壳，Mod 浏览/详情是一个 webview 应用：

```
C:\Program Files\Windhawk\UI\resources\app\extensions\windhawk\webview\
```

安装器做三件事：

1. **部署** `translate.js` 到 webview 目录
2. **注入**：在 `webview/index.html` 末尾添加 `<script src="translate.js">`
3. **放行**：修改扩展 `dist/extension.js` 生成的 Content-Security-Policy，允许 webview 访问翻译 API 域名

`translate.js` 监听详情页渲染出的 README 容器，把英文文本批量送去翻译（Google → Bing → MyMemory），翻译结果写回页面并缓存到本地。

## 📦 文件

```
windhawk-mod-translator/
├── WindhawkModTranslator.exe   # 一键安装器（单文件，内嵌 translate.js）
├── translate.js                # 翻译脚本本体
├── install.ps1                 # PowerShell 安装脚本（备选，管理员运行）
├── src/
│   ├── installer.cs            # 安装器源码（C#）
│   └── app.manifest            # UAC 清单
└── README.md
```

## 🛠️ 从源码构建安装器

需要 .NET Framework 4.x（Windows 自带 csc）：

```bat
"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /r:System.Windows.Forms.dll /win32manifest:src\app.manifest /resource:translate.js,translatejs /out:WindhawkModTranslator.exe src\installer.cs
```

## 📄 License

[MIT](LICENSE)

---

**免责声明**：本工具与 Windhawk 官方无关，仅为个人使用方便而制作。翻译内容由第三方翻译服务提供，可能存在偏差。
