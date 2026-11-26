# FrameLedger · 渲染帧检查器

动画渲染中断后，文件夹里的图片数量不足以确定从哪一帧继续。FrameLedger 按镜头计划查出缺帧、空文件、PNG 损坏和尺寸错误，把需要重跑的帧写成清单。Blender 可以按清单补图，原目录和补帧目录可一起验收。核心算法使用 MoonBit，浏览器与命令行共用同一份实现。

## 直接使用

双击 `dist/FrameLedger.html`。页面首先显示一个用 Blender 5.3 实际渲染的故障示例。8 帧里有 5 帧通过检查，第 3 帧缺失，第 5 帧是零字节占位文件，第 7 帧被截断。单文件网页内含程序和示例，所选图片在浏览器内读取。

1. 点击「选择文件夹」，选中存放单个镜头序列的目录。程序只检查第一层的文件。
2. 按场景的输出设置填写命名模板、首尾帧和步长。例如 `shot_####.png` 对应 `shot_0001.png`。请使用原计划的结束帧，以便发现中断后缺失的尾段。
3. 点击「检查帧序列」。补渲染清单把相邻的问题帧合并。可展开文件诊断，也可点击「导出 JSON」保存报告。

### 命令行

补渲染图可放在单独目录。点击网页的「添加补帧目录」，或在命令行追加一个或多个 `--overlay <目录>`。工具逐份检查，同一帧优先使用通过检查的副本；多份均可用时，按原目录、各补帧目录的顺序选取。报告中的 `ready_from_overlay` 是补帧目录实际贡献的帧数。

解压完整项目包，在项目目录用 Node.js 20 或更高版本运行。预编译文件已随包提供。

```sh
node cli.mjs examples/interrupted "shot_####.png" 1 8
node cli.mjs examples/interrupted "shot_####.png" 2 8 --step 2 --json
```

第一条返回补渲染帧号 3、5、7，退出码为 1。第二条检查第 2、4、6、8 帧，退出码为 0。退出码 2 表示输入或读取出错。`--fast` 仅按文件存在与非空检查，适合先清点大型序列。JSON 的 `png_checked` 是实际进行 PNG 校验的文件数。

## 检查规则

### 从 Blender 读取镜头设置

在项目根目录运行下面两条命令，可直接使用场景的输出文件名、首尾帧、步长及 PNG 渲染尺寸。网页也可通过「导入镜头设置」读取同一个 JSON。导出器面向场景的单视图主图像序列。裁剪渲染会省略预期尺寸。镜头设置不包含原始目录路径，来自已保存场景的设置会带有文件摘要和场景名。

```sh
blender --background shot.blend --python-exit-code 7 --python blender/shot_settings.py -- shot.json
node cli.mjs renders --job shot.json --json
```

### 只补渲染报告中的帧

```sh
node cli.mjs renders --job shot.json --output audit.json
blender --background --disable-autoexec shot.blend --python-exit-code 7 --python blender/repair.py -- audit.json repaired
node cli.mjs renders --job shot.json --overlay repaired
```

第一条命令在发现问题帧时返回 1，报告已经写入磁盘。第二条核对场景摘要、帧段、尺寸与分类计数，然后在独立目录内逐帧渲染。末尾加 `--dry-run` 可预览帧段。每张补图经完整写入后才进入输出目录，同时记录 SHA-256。重跑时，已有且通过摘要核对的补图直接复用。此流程只处理单视图场景的主输出，带有已启用的合成器 File Output 节点的场景需先安排该节点的输出。

交付前可指定 PNG 输出分辨率。例如 `node cli.mjs examples/interrupted "shot_####.png" 1 8 --size 64x48`。即使预览图有完整的 PNG 结构和正确的 CRC，分辨率与镜头计划不符也会列入补渲染清单。

另一个 MoonBit 工程可以导入本库，用 `FramePattern::parse` 匹配通道，逐帧调用 `AuditSession::observe`，随时通过 `report()` 获取当前补帧区间。`moon run examples/library --target js` 会运行一个左右眼分开命名、步长为 2 的镜头示例。

- 一组连续的 `#` 指定最小数字位数，前后文字逐字匹配。`shot_###_L.png` 可匹配 `shot_-003_L.png` 和 `shot_1000_L.png`。正负号之外的数字位数须符合模板，左右眼和不同输出通道可分别检查。
- 首尾帧均包含在输入范围内，步长从起始帧起算。如起始为 1、结束为 8、步长为 3，所查帧号为 1、4、7。支持的帧号范围为 −10 亿至 10 亿。
- PNG 校验以最多 128 KiB 的数据块读取文件，核对文件签名、IHDR 位置和长度、连续的 IDAT、结束块以及各块 CRC。像素解码、视觉质量和颜色正确性需另行检查。EXR、JPEG 等格式只按文件存在与非空检查。
- 命令行只扫描当前目录中的普通文件。补帧区间按步长压缩。缺少大段序列时，算法按已有帧排序后找间隙，耗时随实有文件数量变化。

## 构建与验证

本地验证使用 MoonBit `v1.0.0-rc1+3c0520448` 与 Node.js `26.13.0`。项目使用 MoonBit 标准库和 Node 内置模块。

```sh
npm run verify
```

本地和持续集成共用这条命令，检查格式、类型、正式构建、JavaScript 与 WebAssembly 测试，并生成本地 MoonBit 包。Node 集成测试包含真实 PNG 的不同分块方式、中段数据位翻转、命令行退出码，以及与逐帧参考算法对照的 600 组随机帧段。

`examples/interrupted` 收录随包的故障样本。`examples/render.py` 可以用 Blender 的出厂默认场景重新生成 8 张完整图。请将最后一个参数设为一个新的测试目录。

```sh
blender --background --factory-startup --python-exit-code 7 --python examples/render.py -- ./clean-frames
node cli.mjs ./clean-frames "shot_####.png" 1 8
```

## 实现与来源

真实渲染的中断、补帧、重试及完整渲染的像素对照结果见[渲染恢复验证](evidence/validation.md)，另附一个已暂停生产镜头的只读检查结果。

使用 PowerShell 7 在 Git 工作副本中运行 `./tools/release.ps1 -OutputDirectory ./release`，可从当前提交重新生成离线网页、完整源码及本地 Git 历史包。脚本在临时目录重新构建与运行测试，再解压交付包逐文件校验。压缩包中的 `development-history.bundle` 可通过 `git clone development-history.bundle frameledger-source` 还原为 Git 工作副本。

`sequence.mbt` 解析模板和有符号帧号，`audit.mbt` 汇总间隙与文件状态，`png.mbt` 维护跨读取块的 PNG 校验状态。`app/scan.mjs` 将两个用户入口接到同一份 MoonBit 核心。项目由 Codex 辅助实现和验证，示例场景由仓库内脚本生成。

命名和步长参考 Blender 的图像序列工作流程。PNG 检查依据 W3C 规范。[Blender 动画渲染手册](https://docs.blender.org/manual/en/latest/render/output/animation.html) · [W3C PNG 规范](https://www.w3.org/TR/png-3/)

项目代码采用 MIT 许可证。编译产物包含 MoonBit 标准库的部分实现，随包保留 Apache 2.0 许可文本。
