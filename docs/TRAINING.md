# VIVBLOOM LoRA 训练手册

给 Vivian 自己看的，一步一步照着做就行。

---

## 0. 你需要准备的东西

- 用 dataset-prep.html 导出的 `dataset.zip`（40–50 张图 + caption）
- 一张信用卡（fal.ai 充值用，训练一次大约 $2）
- 大约 30 分钟（训练本身 10–15 分钟，剩下是验收测试）

---

## 1. 注册 fal.ai

1. 打开 https://fal.ai ，用 GitHub 或 Google 账号注册
2. 进 Dashboard → Billing，充值 $10（够训练好几轮 + 测试推理）
3. 进 Dashboard → Keys，创建一个 API Key，复制保存好（后面 Vercel 要用）

---

## 2. 上传数据集

1. 打开 https://fal.ai/dashboard/files
2. 点 Upload，把 `dataset.zip` 传上去
3. 上传完成后，右键复制文件的 URL（长得像 `https://fal.ai/files/xxxxx/dataset.zip`）
4. 记下这个 URL，下一步要用

---

## 3. 开始训练

1. 打开 https://fal.ai/models/fal-ai/flux-lora-fast-training/playground
2. 填写参数：

| 参数 | 值 | 说明 |
|------|-----|------|
| `images_data_url` | 刚才复制的 zip URL | 你的数据集 |
| `trigger_word` | `VIVBLOOM` | 触发词，全大写 |
| `is_style` | `true` | 告诉模型这是风格训练，不是某个具体物体 |
| `steps` | `1000` | 首轮用 1000 步，后面根据效果调 |

3. 其他参数保持默认，点 **Run**
4. 等 10–15 分钟，训练完成后页面会返回结果
5. 在结果里找到 `diffusers_lora_file` → `url`，这是你的 LoRA 权重文件地址（`.safetensors`）
6. **复制保存这个 URL**——这就是后面 Vercel 环境变量 `LORA_URL` 的值

---

## 4. 验收测试

训练完不要急着用，先测试效果。

1. 打开 https://fal.ai/models/fal-ai/flux-lora/playground
2. 用下面 5 组 prompt 逐个测试（每次都要填 LoRA 参数）：

**LoRA 参数（每次都要填）：**
- `loras` → 添加一项：
  - `path`: 第 3 步保存的 .safetensors URL
  - `scale`: `1.0`

**测试 prompt：**

```
1. a VIVBLOOM bouquet with peonies and garden roses, soft blush pink
2. a VIVBLOOM bouquet with tulips and ranunculus, warm coral
3. a VIVBLOOM bouquet with chamomile and eucalyptus, white and green
4. a VIVBLOOM bouquet with sunflowers and dried flowers, autumn tones
5. a VIVBLOOM bouquet with lilies and lisianthus, lavender purple
```

**每张图检查三件事：**

- [ ] **风格像不像**——包装纸质感、配色逻辑、光线氛围跟你的真实作品对得上吗？
- [ ] **花材对不对**——prompt 里写了牡丹，图里画的是牡丹还是别的？
- [ ] **不是照抄原图**——生成的图应该是新的构图，不是训练集里某张的复制品

---

## 5. 调优决策树

测试结果不理想？按下面的情况对症下药：

### 风格太淡（看起来不像你的作品）

→ 重训，把 `steps` 加到 **1500–2000**

### 花材总画错（prompt 写玫瑰但出来的不是玫瑰）

→ 过拟合了，两个选择：
- 重训，`steps` 降到 **700–800**
- 或者不重训，推理时把 LoRA `scale` 从 `1.0` 降到 **0.7–0.8**

### 生成结果看起来都差不多（换什么 prompt 出来都像同一束花）

→ 数据集问题，检查是不是某个色系/花材占比太高
→ 重新配比数据集（保证多样性），然后重训

### 出现训练集原图的复制品

→ 明显过拟合，`steps` 降到 **700–800**，同时检查数据集里是否有同一束花的多个近似角度（最多留 2 个）

---

## 6. 训练完成后要保存的东西

把这三个值记下来，部署网站的时候要用：

| 环境变量名 | 值 | 来源 |
|-----------|-----|------|
| `FAL_KEY` | `fal-xxxxxxxx` | fal.ai Dashboard → Keys |
| `LORA_URL` | `https://...safetensors` | 训练结果里的 diffusers_lora_file.url |
| `LORA_SCALE` | `1.0`（或调优后的值） | 验收测试确定的最佳值 |

---

## 7. 费用参考

| 操作 | 单价 | 说明 |
|------|------|------|
| 训练 1000 步 | ~$2 | 步数线性增长，2000 步约 $4 |
| 单次推理（生成一张图） | ~$0.05 | 用户每点一次「Generate」的成本 |
| 验收测试 5 张 | ~$0.25 | |

充 $10 足够训练 2–3 轮 + 几十次测试推理。
