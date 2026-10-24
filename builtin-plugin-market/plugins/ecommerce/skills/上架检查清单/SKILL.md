---
name: 上架检查清单
description: Check a product listing item by item before it is published on Taobao/Tmall, JD, Pinduoduo, Douyin or Xiaohongshu, and report each item as passed, failed or unverifiable with the fix. Use right before a listing goes live, when an existing listing is audited, or when the user asks whether a listing is ready.
display-description:
  zh-CN: 上架前逐项检查标题、价格、SKU、主图、详情页和违禁词
  en-US: "Check a listing before it goes live: title, price, SKUs, images, detail page, banned words"
trigger: A listing is about to be published, or the user asks to check or audit a listing.
argument-hint: "[商品资料、链接内容或截图，以及要上的平台]"
---

# Listing checklist

Check the listing the user provides against every item below. Work only from what the user gives you (product information, the draft or live listing text, screenshots, the page the user has open). An item you cannot see is **unverifiable**, never passed.

First state the platform and category the check applies to. Platform rules (title length, image specifications, required category attributes, qualification documents, banned words, promotion and price display rules) differ by platform and category and change often; where an item depends on such a rule, apply it as you understand it and add "以平台规则中心当前规定为准" to that item.

## Items

1. **Category and attributes**: the product sits in the correct category; required attributes (brand, model, material, size, origin and so on) are filled in and match the product information.
2. **Title**: contains the core product noun and the key attributes; within the platform's length limit; no unrelated keywords, no other brands' names, no absolute or unverifiable claims.
3. **Price and SKUs**: every SKU has a price; SKU names are clear (colour, size, bundle) and consistent with images; the price matches the price the user set; any strike-through or reference price follows the platform's price display rules and is backed by the user's records.
4. **Stock and shipping**: stock is set for every SKU and matches the user's ERP or stock figures; promised dispatch time, shipping regions and freight template are set and realistic.
5. **Main images**: the required number of images is present; the first image shows the product clearly and meets the platform's background and text rules; images match the real product and the SKU options; no watermarks or material the store has no rights to.
6. **Detail page**: covers selling points, specifications, size or usage guidance and after-sales information; every claim appears in the product information; no claim beyond the product's evidence.
7. **Qualifications**: the category's required documents (for example 3C certification, quality inspection reports, food or cosmetics registration, brand authorisation) are available when the category needs them. Ask the user if unsure; do not assume they exist.
8. **Compliance wording**: scan the title, images text, detail page and SKU names for absolute terms (最, 第一, 顶级, 国家级, 100% and similar), efficacy or medical claims for ordinary goods, false urgency and misleading comparisons. Give a compliant alternative for each hit.
9. **After-sales information**: return and exchange terms, warranty and service promises shown on the page match the store's actual policy as the user stated it.
10. **Consistency across platforms** (when the product is listed on several platforms): facts, specifications and after-sales terms agree everywhere; differences in price or bundle are intentional.

## Output

A table with columns: item, result (通过 / 不通过 / 无法确认), what you found, how to fix. Then list the fixes in priority order and the information you still need from the user. If anything failed, say the listing is not ready and offer to run the check again after the fixes.
