# RNGdle Top 1% Farmer

自动刷 [rngdle.com](https://rngdle.com) 的每日随机数，直到掷出 **Mythic（Top 1%）** 稀有度，然后把信息写入文件并截图保存。

## 原理

通过逆向站点前端得到的关键结论：

- 掷数完全在客户端完成：`Math.floor(1000001 * Math.random())`
- 结果写入 `localStorage`：
  - `rngdle_guest_roll_data` — `{ number, badges, totalScore }`
  - `rngdle_guest_roll_date` — 当天日期
- 每天只能掷一次的限制就是靠这两个键实现的：**删掉它们并刷新即可重新掷数**
- 稀有度由站点内置的 `SCORE_PERCENTILES`（EP → 百分位）表决定：
  - `Mythic = 百分位 ≥ 99 = Top 1%`
  - 对应 **EP ≥ 162,292**

因此脚本不需要等待页面上约 20 秒的 EP 滚动动画，读 `localStorage` 里的 `totalScore` 即可立即判断是否达标。

## 使用

```bash
npm install
npx playwright install chromium     # 首次需要（国内可加镜像）
npm start
```

> Windows PowerShell 若提示「npm.ps1 / npx.ps1 因执行策略被禁止运行」，改用 `npm.cmd install`、`npx.cmd playwright install chromium`、`npm.cmd start`。

国内下载 Chromium 慢时：

```powershell
$env:PLAYWRIGHT_DOWNLOAD_HOST="https://cdn.npmmirror.com/binaries/playwright"
npx.cmd playwright install chromium
```

### 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WORKERS` | `4` | 并行 worker 数，每个 worker 独立存储、独立掷数 |
| `MAX_MINUTES` | `30` | 超时时间，超时未中则退出码为 1 |
| `HEADLESS` | `1` | 设为 `0` 可看到浏览器窗口 |

```powershell
$env:WORKERS=8; $env:MAX_MINUTES=15; $env:HEADLESS=0; node farm.js
```

期望次数约 100 次（1% 概率），实测 4 并发下 46 秒 / 62 秒各命中一次。

## 产出

均在 `output/` 下：

| 文件 | 内容 |
| --- | --- |
| `result.txt` | 人读报告：号码、EP、等级、百分位、徽章明细、分享文案 |
| `result.json` | 同上（机器可读） |
| `top1.png` | 命中结果页全页截图 |
| `top1_<时间戳>.png` | 截图的历史副本 |

`result.txt` 示例：

```
Number        : 376543
EP            : 489,438
Tier          : MYTHIC (Top <1%)
Percentile    : 99.7775
Badges        : 18
  [EPIC    ] 📏 Straight  +454,546 EP
  ...
```

## 文件说明

```
farm.js                  主程序（循环掷数 + 命中后截图/写文件）
SCORE_PERCENTILES.json   从站点提取的 EP → 百分位表（60,392 条）
package.json
output/                  运行结果
```

判定阈值 `MYTHIC_MIN_SCORE = 162292` 写在 `farm.js` 顶部，若站点更新评分规则需重新提取。

## 注意事项

- Guest 掷数只存在浏览器本地，**不会进入全站排行榜**；站点要求注册登录后才会保存成绩。本项目只负责把本地这一掷刷到 Top 1%。
- 每个 worker 是隔离的浏览器上下文，互不影响。
- 请适度使用，避免对站点造成过大请求压力。
