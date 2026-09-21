# 仓库信息（建仓时直接复制）

给「屏风 ScreenFold」建仓库时用得上的所有文案，按 GitHub 建仓表单的顺序排好了。

---

## 1. Repository name

**首选：`screenfold`**

理由：

- `package.json` 里的 `name` 已经是 `screenfold`，内部路径也用它 —— 用同名开仓不用动任何代码。
- 「屏风」的直译，`fold` 还自带一层「不用时折起来收掉」的双关，正好对应「移开就收」。
- 短、好念、好搜，纯英文，不被拼音绊住。

**备选（按推荐度排）**

| 名字 | 什么情况下用 |
|---|---|
| `codecurtain` | 想把「伪装成代码」这层卖点直接写进名字，故事感更强（代码即幕帘） |
| `foldpane` | 想让它听起来更像正经的桌面小工具，少一点戏谑 |
| `screenfold-app` | `screenfold` 在 GitHub 上已被占用时的退路 |

> 别用拼音 `pinfeng` —— 读不出来，也不利于别人搜到。

---

## 2. Description（仓库首页那句 About）

**中文（首选，短）**

```
一块看起来不像视频的屏幕 —— 鼠标移进才出画面，移开自动变回源码的桌面小面板。
```

**中文（长一点，把伪装的可信度讲清楚）**

```
常驻桌面、置顶、无边框的小面板。标题栏写着 feed.aggregator.ts，左边一排行号，状态栏显示 Ln 42, Col 8 —— 从任何角度看都是一个打开的代码文件。只有鼠标移上去，它才变成抖音 / B站 / 虎牙 / 快手。
```

**English**

```
A tiny always-on-top desktop panel disguised as an open source file. Hover to reveal the video; move away and it folds back into code.
```

---

## 3. Topics（标签，最多 20 个）

```
electron  desktop-app  always-on-top  frameless-window  video-player
disguise  privacy-screen  webview  windows  javascript  vscode
```

---

## 4. README 开头（仓库首页正文）

现有 `README.md` 的开头已经合用，直接沿用即可：

```markdown
# 屏风 · ScreenFold

> 一块看起来不像视频的屏幕。

一个常驻桌面的小面板。标题栏是 `feed.aggregator.ts`，状态栏写着 `main · M 2 · Ln 42, Col 8`，
左边一排行号 —— 从任何角度扫过去，这就是一个打开的代码文件。

只有你主动要的时候，它才变成抖音 / B站 / 虎牙 / 快手。
```

**卖点清单**（放在简介后面，一眼看懂它会什么）

```markdown
## 它凭什么不像视频

- **外壳永远在场** —— 标签栏、行号槽、状态栏从不消失，所以「来不及藏」也不是破绽。
- **内容自洽** —— 标签名、面具里的源码、窗口标题，三处指向同一个文件，对得上。
- **五套面具** —— 源码 / diff / 运行日志 / 单元测试 / git 提交图，后四套按当时状态现场生成，不是贴图。
- **假界面会动** —— 光标在闪、代码在滚、日志在追加。静止的假界面反而可疑。
- **零按键** —— 鼠标移进去就显示，移开就收回。没有任何快捷键需要记。
- **移开之后可选** —— 变回代码，或者连窗口一起藏掉（托盘图标 / `Alt+V` 叫回来）。
```

---

## 5. 建仓 + 首次推送

`.gitignore` 已经写好（`node_modules/`、自检日志、临时 profile 都已排除）。

```bash
cd "C:/Users/AMBITIOUS_YUAN/WorkBuddy/2026-09-17-15-42-00/screenfold"

git init -b main
git add -A
git commit -m "feat: 屏风 ScreenFold v3 —— 五套面具 / 内容自洽 / 零按键交互"

git remote add origin https://github.com/<你的用户名>/screenfold.git
git push -u origin main
```

**License**：`package.json` 里已声明 MIT。如果决定公开，记得补一个 `LICENSE` 文件，
不然 GitHub 侧边栏会显示「未声明许可证」。

---

## 6. 一句话版本（发帖 / 群里介绍用）

> 写了个 Electron 小窗，伪装成 VS Code 里打开的一个 `.ts` 文件。
> 鼠标移上去是 B站，手一挪就缩回源码，还带行号和 diff。
> 不占快捷键，没有按钮，就靠鼠标停靠。
