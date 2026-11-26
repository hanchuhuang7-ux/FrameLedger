# FrameLedger · 渲染帧检查器

A MoonBit library and offline tool for auditing image sequences, stereo deliveries and Blender recovery jobs.

动画渲染中断后，文件夹里的图片数量不足以确定从哪一帧继续。FrameLedger 按镜头计划检查 PNG、单层和多层扫描线 EXR，列出缺失、空文件、结构异常和交付规格不符的帧。Blender 可以按清单补图，两个目录可以一起验收。浏览器和命令行共用同一份 MoonBit 核心。

## 直接使用

双击 `dist/FrameLedger.html`。GitHub 发行版也提供可单独下载的离线网页。默认示例来自 Blender 的两个相机位置，8 对图像中有 5 对齐全。查看左右眼可分别看到需要重跑的帧。另有 PNG 中断示例及包含截断文件、tiled 文件的 EXR 示例。[下载发行版](https://github.com/hanchuhuang7-ux/FrameLedger/releases)

1. 点击「选择文件夹」，选中存放单个镜头序列的目录。程序只检查第一层的文件。
2. 按场景的输出设置填写命名模板、首尾帧和步长。例如 `shot_####.png` 对应 `shot_0001.png`。请使用原计划的结束帧，以便发现中断后缺失的尾段。
3. 点击「检查帧序列」。补渲染清单把相邻的问题帧合并。可展开文件诊断，也可点击「导出 JSON」保存报告。

### 双目与其他成组交付

若左右眼、遮罩或其他输出须一起交付，在网页选择共同的根目录，导入 `frameledger.delivery.v1` 清单。各组可指定自己的子目录、命名模板、尺寸及必需 EXR 通道，使用共同的起止帧和步长。文件路径以选择的根目录为基准。`examples/stereo-job.json` 是可直接运行的例子。

```sh
node cli.mjs examples/delivery --job examples/stereo-job.json
node cli.mjs examples/delivery --job examples/stereo-job.json --only 左眼 --output left-audit.json
```

整套通过数要求同一帧的所有必需输出通过。汇总对多个输出中的相同问题帧去重。单组报告保留自己的缺失、异常和待复核清单。「仅待复核」表示该帧的其他输出均未发现需要重跑的故障。对某个输出补图时使用它自己的报告。若希望把单组报告直接交给 Blender，需保留对应已保存场景导出的 `origin`。补帧根目录应保持相同的子目录结构。

### 命令行

补渲染图可放在单独目录。点击网页的「添加补帧目录」，或在命令行追加一个或多个 `--overlay <目录>`。工具逐份检查，同一帧优先使用通过检查的副本；多份均可用时，按原目录、各补帧目录的顺序选取。报告中的 `ready_from_overlay` 是补帧目录实际贡献的帧数。

解压完整项目包，在项目目录用 Node.js 20 或更高版本运行。预编译文件已随包提供。

```sh
node cli.mjs examples/interrupted "shot_####.png" 1 8
node cli.mjs examples/interrupted "shot_####.png" 2 8 --step 2 --json
node cli.mjs examples/exr --job examples/exr-shot.json --json
```

第一条返回补渲染帧号 3、5、7。第二条检查第 2、4、6、8 帧，全部通过。第三条输出多层 EXR 示例报告。退出码 0 表示按所选模式全部通过，1 表示存在要补的帧，2 表示输入或运行出错，3 表示只剩待复核帧。`--fast` 可按非空文件快速清点。JSON 的 `png_checked` 和 `exr_checked` 记录进入相应结构检查并得到结果的文件数。

## 检查规则

### 从 Blender 读取镜头设置

在项目根目录运行下面两条命令，可直接使用场景的输出文件名、首尾帧、步长及 PNG 或 EXR 渲染尺寸。网页也可通过「导入镜头设置」读取同一个 JSON。导出器面向场景的单视图主图像序列。裁剪渲染会省略预期尺寸。已保存场景的设置带有文件摘要和场景名。

```sh
blender --background shot.blend --python-exit-code 7 --python blender/shot_settings.py -- shot.json
node cli.mjs renders --job shot.json --json
```

若交付要求深度、法线等通道，可在导出镜头时指定一张已经确认正确的参考帧。导出器读取通道名并写入 `required_exr_channels`。扫描工具核对每个必需项，允许帧内含有额外通道。补渲染脚本在复用或写入补图前也会核对它们。

```sh
blender --background shot.blend --python-exit-code 7 --python blender/shot_settings.py -- shot.json --reference-exr known-good.exr
node cli.mjs renders --job shot.json --output audit.json
```

也可在网页展开「EXR 必需通道」，每行输入一个名称。命令行可重复使用 `--require-channel`，例如 `node cli.mjs examples/exr "shot_####.exr" 1 2 --require-channel ViewLayer.Depth.Z`。这个例子中尺寸相同的两张 EXR 只有第 2 帧包含所需通道。

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
- PNG 以最多 128 KiB 的块读取，核对签名、IHDR、连续 IDAT、结束块和各块 CRC。JPEG 等其他格式按文件存在与非空检查。
- EXR 读取版本、必需头属性、通道采样、每个分部的 64 位偏移表、扫描线坐标与数据块边界。尺寸要求按显示窗口计算，数据窗口用来确定实际区块。参考通道按区分大小写的完整名称匹配，支持中文。像素内容或压缩载荷中保持长度的位变化，需要独立解码对照。
- tiled、deep、未知压缩或超出预算的 EXR 单列待复核。预算为 16 MiB 文件头、每个已解析结构属性 1 MiB、每部 4096 个属性、256 个分部、总计 100 万个区块。单个文件在扫描期间变得不可读，或命令行发现其长度、时间戳或文件标识变化，也会单列复核。
- 报告有待复核帧或通道约束时使用 `frameledger.report.v2`，其余报告沿用 v1。`unverified` 内的帧可在写入完成后重查或交给相应格式的解码器。`rerender` 只包含已经确认需要重跑的区间。修复工具兼容 0.2.0 的报告和省略 EXR 尺寸的镜头设置。
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

`sequence.mbt` 解析模板和有符号帧号，`audit.mbt` 汇总间隙与文件状态，`png.mbt`、`exr.mbt` 和 `exr_header.mbt` 负责流式结构检查。MoonBit 调用者可使用 `ExrProbe::new` 与 `feed`，根据返回值处理通过、异常和待复核结果。项目由 Codex 辅助实现和验证，示例场景由仓库内脚本生成。

命名和步长参考 Blender 的图像序列工作流程。文件结构检查依据公开规范。EXR 参考样本使用 Blender 和 OpenEXR 官方 Python 模块生成、解码。离线网页和扫描命令本身使用 MoonBit 与宿主内置功能。[Blender 动画渲染手册](https://docs.blender.org/manual/en/latest/render/output/animation.html) · [W3C PNG 规范](https://www.w3.org/TR/png-3/) · [OpenEXR 文件布局](https://openexr.com/en/latest/OpenEXRFileLayout.html) · [OpenEXR Python 模块](https://openexr.com/en/latest/python.html)

项目代码采用 MIT 许可证。编译产物包含 MoonBit 标准库的部分实现，随包保留 Apache 2.0 许可文本。
