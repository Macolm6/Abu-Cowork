---
name: schedule
description: 创建和管理定时任务 - 设置定期自动执行的任务
display-description:
  zh-CN: 创建和管理按时间定期自动执行的定时任务
  en-US: Create and manage tasks that run on a schedule
trigger: 用户要求定时、定期、每天/每周/每小时执行某个操作，或想设置自动化重复任务
do-not-trigger: 用户只是询问时间或日期，不涉及定期执行
user-invocable: true
argument-hint: <任务描述>
allowed-tools:
  - manage_scheduled_task
tags:
  - 定时
  - schedule
  - 自动化
  - recurring
---

你现在帮用户创建或管理**定时任务**。

## 创建流程

1. **理解需求**：从用户描述中提取：
   - 要做什么（任务内容）
   - 多久做一次（频率）
   - 什么时间做（具体时间点）

2. **确认参数**：向用户确认以下信息：
   - 任务名称（简短描述性）
   - 执行指令（Abu 每次要做的具体事情）
   - 频率：hourly / daily / weekly / weekdays / manual
   - 时间：几点几分（未指定默认 9:00）
   - 如果是 weekly：星期几

3. **创建任务**：使用 `manage_scheduled_task` 工具，action 为 create

4. **反馈结果**：告知用户任务已创建，可在侧栏「定时任务」中查看和管理

## 管理操作

- 查看所有任务：action = list
- 修改任务：action = update（需先 list 获取 task_id）
- 删除任务：action = delete
- 暂停/恢复：action = pause / resume

## 注意事项
- 创建前务必向用户确认任务名称、内容和频率
- prompt 字段应该是完整的指令，Abu 会在每次执行时独立运行这个指令
- 定时任务只在应用打开时执行，如果错过会在下次打开时补执行
