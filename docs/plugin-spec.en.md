# Abu Plugins · Developer Specification

**English** | [中文](plugin-spec.md)

> Applies to: Abu 0.51.0 and later. Content marked "0.50.0" is supported from 0.50.0. Content marked "0.51.0" is supported from 0.51.0.
> Related: [App specification](app-spec.en.md); [User guide](User-Guide.md).

## 1. Terms

| Term | Meaning |
|---|---|
| Plugin | A directory that holds a manifest and one or more of these: skills, experts, expert teams, connectors. The user installs it once and everything in it takes effect |
| Skill | A set of working instructions written for the model (`SKILL.md`). It can come with reference material and scripts |
| Expert | A role with its own prompt and its own range of tools (`AGENT.md`) |
| Expert team | One leader and several experts. The user talks only to the leader; the leader assigns the work, reviews it and reports |
| Connector | The declaration of an MCP server, which lets Abu call an external service |
| Market | A directory that holds a `marketplace.json`, which lists plugins and apps together with their sources |
| App | Abu prepared for one kind of work, with its own home page and scenes. The rules are in the [app specification](app-spec.en.md). An app can use the skills, experts, expert teams and connectors that plugins bring |

## 2. Package directory

| Path | Required | Description | Minimum Abu version |
|---|---|---|---|
| `.abu-plugin/plugin.json` | Required | The manifest. When it is missing, Abu tries `.claude-plugin/plugin.json` and then `.codex-plugin/plugin.json` | 0.50.0 |
| `skills/<skill directory>/SKILL.md` | Optional | A skill. The file name can also be `skill.md` | 0.50.0 |
| `agents/<expert directory>/AGENT.md` | Optional | An expert, in Abu's own shape | 0.50.0 |
| `agents/<name>.md` | Optional | An expert, in the single-file shape. Files of any other type under `agents/` are not treated as experts | 0.50.0 |
| `teams/<expert team id>.json` | Optional | An expert team | 0.51.0 |
| `.mcp.json` | Optional | Connector declarations, read automatically | 0.50.0 |
| The JSON file that the manifest field `mcpServers` points to | Optional | Connector declarations | 0.50.0 |
| `assets/` | Optional | Logo, icons, screenshots | 0.50.0 (the paths are given by manifest fields) |
| `commands/`, `hooks/` | — | Abu does not use them. The install confirmation dialog lists them under "Not used by Abu" | 0.50.0 |

Symbolic links in a package are not copied, and the install confirmation dialog lists the symbolic links that were skipped. When the root directory of the package is itself a symbolic link, the installation is refused.

## 3. Manifest `plugin.json`

### 3.1 Top-level fields

| Field | Required | Type | Description | Minimum Abu version |
|---|---|---|---|---|
| `name` | Yes | string | The unique name of the plugin. It must not be empty | 0.50.0 |
| `version` | No | string | A semantic version number, for example `1.2.0`. Raise it with every release and keep it equal to the `version` of the market entry | 0.50.0 |
| `description` | No | string | A one-sentence description | 0.50.0 |
| `author` | No | string or `{ name, email? }` | The author | 0.50.0 |
| `license` | No | string | The license | 0.50.0 |
| `keywords` | No | string[] | Keywords for search | 0.50.0 |
| `skills` | No | string or string[] | Relative paths of skill directories. They must be inside the package | 0.50.0 |
| `mcpServers` | No | string or object | A string is the relative path of a JSON file inside the package. An object is an inline declaration. The rules are in section 7 | 0.50.0 |
| `interface` | No | object | Display information, see 3.2 | 0.50.0 |
| `minAbuVersion` | Required when the package uses `teams/` | string | The minimum Abu version this package requires. An Abu below this version does not show the package; a package that is already installed is shown as unavailable with a prompt to upgrade | 0.51.0 |

Top-level fields that Abu does not know are kept as they are, and they do not cause the manifest to be rejected.

### 3.2 Display information `interface`

| Field | Type | Rule |
|---|---|---|
| `displayName` | string | The display name |
| `shortDescription` | string | A one-sentence introduction |
| `longDescription` | string | The long introduction on the detail page |
| `developerName` | string | The name of the developer |
| `category` | string | The category |
| `capabilities` | string[] | Plain-language statements of what this plugin does and what it reads. They are shown in the install confirmation dialog |
| `brandColor` | string | Must be `#RRGGBB`. The short form `#RGB` is not accepted |
| `logo`, `logoDark` | string | Relative paths of images inside the package, one for the light interface and one for the dark interface |
| `composerIcon` | string | The small icon in the input box, as a relative path inside the package |
| `screenshots` | string[] | Every item must be the path of a `.png` file |
| `defaultPrompt` | string[] | At most 3 items, each at most 128 characters |
| `websiteURL`, `privacyPolicyURL`, `termsOfServiceURL` | string | The website, the privacy policy and the terms of service |

### 3.3 Example

`abu-prd-doctor` from the official market (one manifest and one skill):

```json
{
  "name": "abu-prd-doctor",
  "version": "1.0.0",
  "description": "Give a PRD a structured check-up",
  "author": { "name": "Abu", "email": "hello@abu.example" },
  "license": "MIT",
  "keywords": ["prd", "review", "product"],
  "skills": ["./skills/prd-doctor"],
  "interface": {
    "displayName": "PRD Check-up",
    "shortDescription": "A quick PRD review along three lines: flow / exceptions / wording",
    "developerName": "Abu",
    "category": "productivity",
    "capabilities": ["Reads the PRD text you paste in", "Produces a structured review checklist"],
    "brandColor": "#C4633A"
  }
}
```

## 4. Skill `SKILL.md`

The file consists of YAML frontmatter and a Markdown body. The body holds the working instructions written for the model.

| Frontmatter field | Required | Type | Description |
|---|---|---|---|
| `name` | Yes | string | The name of the skill, which is also the name of its directory. It must be a single path segment: it cannot contain `/`, `\` or control characters, and it cannot consist only of `.` |
| `description` | No | string | State the purpose clearly. The model uses it to judge when to use this skill |
| `display-description` | No | Text given per language | The short description shown in the interface. It can be written in both `zh-CN` and `en-US`, or in only one of them. The cards and the detail on the skills page and the `/` list of the input box show the entry for the current interface language; when that language has no entry they show `description`. The model always sees `description`. Supported from 0.51.0; an earlier Abu ignores this field |
| `trigger` | No | string | The situations in which the skill should be used |
| `do-not-trigger` | No | string | The situations in which the skill should not be used |
| `argument-hint` | No | string | The argument hint shown when the user calls the skill with `/skill-name` |
| `user-invocable` | No | boolean | Default `true`. When set to `false`, the user cannot call the skill directly with `/` |
| `disable-auto-invoke` | No | boolean | Default `false`. When set to `true`, the model does not use the skill by itself, and only the user can call it |
| `allowed-tools`, `blocked-tools`, `required-tools` | No | string[] or a space-separated string | The tools that are allowed, forbidden and required while this skill runs |
| `model` | No | string | The model to use |
| `max-turns` | No | number | The maximum number of turns |
| `context` | No | `inline` or `fork` | Default `inline`: the skill runs in the current conversation. `fork`: the skill runs in a separate context |
| `agent` | No | string | The expert that runs the skill when `context` is `fork` |
| `skills` | No | string[] | Other skills to load in advance |
| `tags`, `chain` | No | string[] | Tags; the skills that are chained after this one |
| `license`, `compatibility`, `metadata` | No | — | Compatibility fields of the Agent Skills specification |

`description` is written for the model and `display-description` is written for the user. Both can be present at the same time:

```yaml
description: Analyze an alert automatically, investigate the problem by the SOP and produce a handling report
display-description:
  zh-CN: 自动分析告警信息，按 SOP 排查问题并生成处理报告
  en-US: Analyze an alert, investigate it by the SOP and write a handling report
```

Variables that can be used in the body:

| Variable | Meaning |
|---|---|
| `$ARGUMENTS` | All the arguments the user gave in the call |
| `$ARGUMENTS[N]` | The Nth argument, counted from 0 |
| `${ABU_SKILL_DIR}` | The absolute path of the skill directory |
| `${ABU_SESSION_ID}` | The id of the current session |
| `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}` | Equivalent to the two above, for compatibility with the Claude Code spelling |

When the body does not contain `$ARGUMENTS` and the user gives arguments, the arguments are appended to the end of the body. The other files in the skill directory (reference material, scripts, templates) do not enter the prompt automatically; the model reads them with `read_skill_file` when it needs them. The files under `scripts/` are listed to the model together with their absolute paths.

## 5. Experts

### 5.1 Two shapes

| Shape | Path | Description |
|---|---|---|
| Directory | `agents/<directory>/AGENT.md` | Frontmatter and a body. The body is the system prompt of the expert |
| Single file | `agents/<name>.md` | The same. When there is no frontmatter, the whole file is the prompt and the name is taken from the file name |

Both shapes go through the same conversion at installation, and the result is the same.

### 5.2 Frontmatter fields

| Field | Type | Description |
|---|---|---|
| `name` | string | The name of the expert. The rule is the same as for a skill name: a single path segment |
| `description` | string | One sentence that says what this expert does. Abu uses it to decide whether to hand a piece of work to this expert |
| `avatar` | string | The avatar |
| `model` | string | The model to use |
| `max-turns` | number | The maximum number of turns |
| `tools` | string[] | The tools the expert is allowed to use. When the field is absent, the expert uses the runtime's default range of tools |
| `disallowed-tools` | string[] | The tools the expert is forbidden to use |
| `skills` | string[] | The names of skills to load in advance |
| `background` | boolean | Whether the expert runs in the background |
| `intro` | string | The opening message, shown the first time the user talks to this expert |
| `expertise` | string[] | Areas of expertise, used for display |
| `sample-prompts` | string[] | Example prompts. A click puts the text into the input box and does not send it |
| `category`, `tags` | string, string[] | The category and the tags |
| `i18n` | object | The text shown in another interface language, per locale (`zh-CN`, `en-US`); each locale may give `name`, `description`, `intro`, `expertise`, `sample-prompts` and `tags`. The expert's name stays `name`; this changes only what is displayed |

`tools`, `disallowed-tools`, `skills` and `tags` can be written as an array or as a comma-separated string.

```yaml
i18n:
  en-US:
    name: Listing Copywriter
    description: Writes product titles, selling points and detail pages
    expertise: [Product titles, Detail pages]
```

### 5.3 What Abu does at installation

| Case | Handling |
|---|---|
| The frontmatter contains `memory` | Discarded. A package cannot request access to the user's memory for its own experts |
| The frontmatter contains `source` | Discarded. Abu writes the source of an expert from the plugin that is actually installed, and a package cannot declare the source itself |
| The name is the same as a built-in expert or an expert the user already has | This expert is not installed, and the install confirmation dialog marks it "Already exists, will not be overwritten". The existing expert is never overwritten |
| The name is not a safe path segment | This expert is not installed and is marked "Invalid name, skipped" |
| The body is empty | This expert is not installed and is marked "No prompt, skipped" |

The names of the built-in experts are in Appendix A.

## 6. Expert teams

File: `teams/<expert team id>.json`. The `id` allows only lowercase letters, digits and `-`. A package that uses `teams/` must declare `minAbuVersion`.

| Field | Required | Type | Description |
|---|---|---|---|
| `name` | Yes | LocalizedText | The name of the expert team |
| `leader` | Yes | Expert reference | The leader |
| `members` | Yes | Expert reference[] | All members, including the leader; at least 2 |
| `leaderNote` | No | string | The briefing for the leader. It enters the leader's prompt when a task arrives. The limit is 4000 characters |
| `requirePlanApproval` | No | boolean | Default `false`. When set to `true`, the leader assigns the work and then waits for the user's approval before the work starts |
| `avatar` | No | string | An emoji, or one of Abu's own icon presets written as `icon:<icon>/<color scheme>` (for example `icon:chart-bar/teal`), the same as for an expert team the user creates; at most 32 characters |
| `description` | Yes | LocalizedText | The one-sentence introduction on the card |
| `intro` | No | LocalizedText | The opening message |
| `expertise` | No | LocalizedText[] | Areas of expertise, at most 5 items |
| `samplePrompts` | No | LocalizedText[] | Example prompts, at most 4 items |

How to write an expert reference:

| Form | Meaning |
|---|---|
| `"expert name"` | An expert in the `agents/` directory of this package |
| `"builtin:expert name"` | An expert built into Abu. The names are in Appendix A |

A `LocalizedText` can be a string or `{ "zh-CN": "…", "en-US": "…" }`. An object holds at least one language; when the current interface language has no text, Abu takes `zh-CN` first and then `en-US`.

When a referenced expert does not exist, manifest validation fails. After installation, an expert team from a package appears under "Experts → Expert Teams → Market", and its card says "From a plugin". The user cannot edit or delete it, and it is removed when the plugin is uninstalled. The experts of a package likewise appear under "Experts → Market"; its skills appear under "Extensions → Skills → Market", each card with its switch.

## 7. Connectors

### 7.1 Where to declare

The declarations in the three places are merged. Validation fails when the same name appears twice.

| Place | Form |
|---|---|
| The `mcpServers` object of the manifest | Inline |
| The `mcpServers` string of the manifest | Points to a JSON file inside the package |
| `.mcp.json` in the root directory of the package | Read automatically |

The content of the JSON file can be the server map itself, or the map wrapped in `{ "mcpServers": { … } }` or `{ "mcp_servers": { … } }`.

### 7.2 Fields of each server

| Field | Type | Description |
|---|---|---|
| `command` | string | The command that starts the local process |
| `args` | string[] | The start arguments |
| `env` | object with string values | Environment variables |
| `url` | string | The address of the remote service |
| `headers` | object with string values | Request headers |
| `transport` | `stdio` or `http` | When absent, it is inferred from `command` or `url` |

Rules:

- The name of a server allows only letters, digits, `_` and `-`, with a length of 1–128.
- Exactly one of `command` and `url` must be present.
- A server with `url` cannot have `args` or `env`; a server with `command` cannot have `headers`.
- The three keys `name`, `enabled` and `pluginConfiguration` are assigned by Abu and cannot appear in a package.
- The install confirmation dialog shows the user the complete start command of every local server.

### 7.3 Configuration the user fills in

Write `${config.FIELD_NAME}` in a value of `env` or `headers`. At installation Abu asks the user to fill in these fields, stores the values in the secret storage of the operating system, and inserts them when it connects.

```json
{
  "mcpServers": {
    "acme-crm": {
      "url": "https://mcp.acme.example/mcp",
      "headers": { "Authorization": "Bearer ${config.ACME_TOKEN}" }
    }
  }
}
```

| Rule | Value |
|---|---|
| Field name | Starts with a letter, contains only letters, digits and `_`, at most 64 characters |
| Where it appears | Only in the values of `env` and `headers`; validation fails when it appears in `command`, `url` or `args` |
| Number of fields | At most 32 per plugin |
| A single value | At most 16KB |
| All values together | At most 64KB |

A package cannot contain any real token, key or password.

## 8. How an app uses plugins

The format of an app, the app entries of a market, delivery and publishing are covered in the [app specification](app-spec.en.md). An app refers to what a plugin brings with the forms below, and the plugin must be listed in `plugins` of the app file:

| Form | Meaning |
|---|---|
| `"team": "plugin:<plugin name>/<expert team id>"` | An expert team in the `teams/` directory of the plugin |
| `"expert": "plugin:<plugin name>/<expert name>"` | An expert of the plugin |
| `"skill": "plugin:<plugin name>/<skill name>"` | A skill of the plugin |
| `<plugin name>/<connector name>` in `requiredConnectors` | A connector the plugin declares |

When a user adds an app, the plugins that are not installed are installed along with it, and an installed version that lacks something the app refers to is updated along with it. For this reason, a new version of a plugin must keep the name of every expert, expert team, skill and connector that an app already refers to, and must keep them in the package.

A complete example of a plugin with an expert team, experts, skills and connectors, and of an app that uses them, is in the repository under `examples/plugin-market/`.

## 9. Images

| Purpose | Field | Format | Recommended size |
|---|---|---|---|
| Plugin logo | `interface.logo`, `interface.logoDark` | PNG or SVG | 256×256, transparent background, one for light and one for dark |
| Small icon in the input box | `interface.composerIcon` | PNG or SVG | 32×32 |
| Screenshots | `interface.screenshots` | PNG only | 1280×800, at most 3 |
| Expert team avatar | `avatar` in `teams/*.json` | An emoji or an icon preset | — |

All images must be inside the package and are referenced by relative paths.

## 10. Security rules

- A package cannot contain real credentials. Values the user must provide are declared with `${config.FIELD_NAME}` (section 7.3).
- The tools an expert can use are decided together by Abu's runtime default range and by the expert's own `tools` and `disallowed-tools`. A package cannot give an expert a tool that Abu does not have.
- Abu decides the `memory` and `source` of an expert (section 5.3).
- A package cannot overwrite the experts the user already has or the built-in experts.
- The `commands/` and `hooks/` directories and symbolic links are not used.
- The confirmation dialog the user sees before installation lists in full: the source and version, the skills, the connectors and their start commands, the configuration to fill in, the experts, the expert teams, and the statements of `interface.capabilities`. What the dialog shows and what is actually installed come from the same immutable snapshot.

## 11. Versions and compatibility

- `version` is a semantic version number and is raised with every release.
- How Abu decides that an update is available depends on the form of the source in the market entry. For a relative-path source, Abu compares the `version` of the market entry with the version the user has installed, and offers the update when the two differ. For a `url` or `git-subdir` source, Abu compares the `sha` pinned in the entry with the `sha` recorded at installation. When the entry has no `version` (relative path) or no `sha` (remote source), Abu offers no update.
- A package that uses `teams/` must declare `minAbuVersion`, and the lowest allowed value is `0.51.0` (`teams/` is supported from this version). A value below `0.51.0` is rejected, and the error points to `minAbuVersion`: an older Abu cannot read `teams/` and would install the package as a plugin without its expert teams.
- Fields and versions:

| Field or capability | Minimum Abu version |
|---|---|
| Everything marked 0.50.0 in sections 3–5 and 7 | 0.50.0 |
| `minAbuVersion` | 0.51.0 |
| `teams/` | 0.51.0 |
| `display-description` of a skill | 0.51.0 |
| `displayName` and `minAbuVersion` of a market entry | 0.51.0 |
| `apps` of a market (see the [app specification](app-spec.en.md)) | 0.51.0 |

## 12. Market `marketplace.json`

File location: `.abu-plugin/marketplace.json` under the market directory. Abu can also read `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`.

| Top-level field | Required | Description |
|---|---|---|
| `name` | Yes | The name of the market |
| `owner` | No | `{ name?, email? }` |
| `description` | No | The introduction of the market |
| `renames` | No | A map from old plugin names to new names. A plugin that was installed under an old name is matched through this map to the entry under its new name |
| `plugins` | Yes | An array of plugin entries |
| `apps` | No | An array of app entries, see [section 5 of the app specification](app-spec.en.md#5-apps-in-a-market) |

| Entry field | Required | Description | Minimum Abu version |
|---|---|---|---|
| `name` | Yes | The name of the plugin, equal to `name` in the manifest | 0.50.0 |
| `displayName` | No | The name shown on the market card, equal to `interface.displayName` in the manifest. When absent, the card shows `name` | 0.51.0 |
| `description`, `version`, `author`, `category`, `homepage`, `keywords`, `tags` | No | Information shown in the market list | 0.50.0 |
| `source` | Yes | Where the plugin is fetched from, see the table below | 0.50.0 |
| `minAbuVersion` | No | Equal to `minAbuVersion` in the manifest. Abu uses it to hide from the market list the packages it cannot use. The official market checks at acceptance that it matches the manifest | 0.51.0 |

| Form of `source` | Meaning |
|---|---|
| `"./plugins/my-plugin"` | A relative path inside the market directory |
| `{ "source": "local", "path": "…" }` | The same |
| `{ "source": "url", "url": "…", "sha": "…" }` | A download address; `sha` is optional |
| `{ "source": "git-subdir", "url": "…", "path": "…", "ref": "…", "sha": "…" }` | A subdirectory of a git repository; `ref` and `sha` are optional |

## 13. Local preview and validation

1. Put the plugin directory into a market directory and write the `marketplace.json`.
2. In Abu, open "Extensions → Plugins → Market", click "Add market" and choose this market directory.
3. Find your plugin in the market and click "Install". The confirmation dialog shows everything Abu read from the package.
4. After you change the package, raise the `version` in both the manifest and the market entry. When Abu finds that the `version` of the market entry differs from the installed version, it shows "Update" on this plugin. The confirmation dialog appears before an update as well.

You can also click "Extensions → Plugins → Add → Create plugin" in Abu and describe in a conversation the work you want to solve; Abu then writes the package according to this specification. When Abu finishes writing, it calls the validation tool itself and corrects the fields named in the errors until validation passes. The draft appears under "Extensions → Plugins → Mine"; click "Validate and preview" to check it, and then install it. The writing instructions Abu reads while it writes a package (the `references/` of the built-in skill `abu-plugin-builder`) agree with section 6, Appendix A and Appendix B of this specification.

When validation fails, the error message gives the full path of the field that failed, for example `interface.brandColor`, `mcpServers.acme-crm.transport`, `teams.store-ops.leader`. Common causes:

| The error points to | Common cause |
|---|---|
| `name` | The manifest has no `name` |
| `interface.screenshots` | A screenshot is not a `.png` |
| `interface.defaultPrompt` | More than 3 items, or one item longer than 128 characters |
| `mcpServers.<name>.transport` | Both `command` and `url` are present, or neither is |
| `mcpServers.<name>.transportFields` | `url` appears together with `args` / `env`, or `command` appears together with `headers` |
| `mcpServers.<name>.configurationLocation` | `${config.…}` is written in `command`, `url` or `args` |
| `mcpServers.configuration` | More than 32 configuration fields |
| `skills`, `mcpServers` (path) | The path points outside the package, or the file does not exist |
| `skills/<directory>` | The `name` in `SKILL.md` is missing, or it cannot serve as a directory name (it contains `/`, `\` or control characters, or it has leading or trailing whitespace) |
| `mcpServers` | It is written as an array; the same name appears once in the manifest and once in `.mcp.json` |
| `teams.<id>.members[n]`, `teams.<id>.leader` | A referenced expert does not exist; the leader is not among the members; there are fewer than 2 members |
| `minAbuVersion` | The package uses `teams/` and does not declare it; the value is not a semantic version number; the current Abu is below the required version |

At acceptance into the official market (`npm run market:check`), two more things are checked: the `name`, `version` and `minAbuVersion` of the entry match the manifest, and every image file the manifest refers to is in the package.

## 14. Checks before submission

- [ ] The manifest has `name`, `version`, `interface.displayName`, `interface.shortDescription` and `interface.logo`.
- [ ] A package that uses `teams/` declares `minAbuVersion`.
- [ ] The `description` of every skill states its purpose and when to use it.
- [ ] The body of every expert is not empty, and no expert has the name of a built-in expert.
- [ ] The connectors contain no real credentials; every value the user must fill in is declared with `${config.FIELD_NAME}`.
- [ ] `interface.capabilities` states, in words a user understands, what the plugin does and what it reads.
- [ ] Every expert, expert team, skill and connector that an app refers to keeps its name and is still present in the new version.
- [ ] All images are inside the package, and the logo has a light version and a dark version.
- [ ] The plugin has been installed completely from the market once in a clean Abu, and the content of the confirmation dialog matched what was expected; nothing remained after uninstalling.
- [ ] The package contains no symbolic links.

## 15. Publishing

Two channels:

| Channel | How |
|---|---|
| Your own market | Put the market directory in a git repository or at a downloadable address. Users connect it through "Add market". The form of the address is described in [5.3 of the app specification](app-spec.en.md#53-market-addresses) |
| The official Abu market | Submit a market entry to the repository of the official market: write the source as `git-subdir` or `url` and pin the `sha`. The Abu team reviews it by hand against the security rules of section 10 and the checklist of section 14. After it passes, it enters the official market with the next Abu version. For an update, submit the new `sha`; it is reviewed again |

The validation that runs at acceptance into the official market is the same one that runs when Abu installs a plugin and when "Validate and preview" is used.

## Appendix A · Names of the built-in experts

`高级开发工程师` (Senior Engineer), `产品经理` (Product Manager), `数据分析师` (Data Analyst), `公众号编辑` (WeChat Editor), `HR 招聘官` (HR Recruiter), `办公文档专家` (Office Docs Specialist), `行业调研专家` (Industry Research Analyst), `网页设计师` (Web Designer), `测试工程师` (QA Engineer), `行政助理` (Admin Assistant), `财务助理` (Finance Assistant), `合同审阅专家` (Contract Reviewer).

These names do not change after release. In a reference, write `builtin:<name>` with the Chinese name exactly as listed; the name in parentheses is the display name in the English interface.

## Appendix B · Ids of the built-in expert teams

| id | Name | Leader | Members |
|---|---|---|---|
| `builtin-team:software-rd` | 软件研发专家团 (Software Development Team) | 产品经理 | 高级开发工程师, 网页设计师, 测试工程师 |
| `builtin-team:data-analysis` | 数据分析专家团 (Data Analysis Team) | 数据分析师 | 行业调研专家, 办公文档专家 |
| `builtin-team:content-creation` | 内容创作专家团 (Content Creation Team) | 公众号编辑 | 行业调研专家, 网页设计师 |
| `builtin-team:reporting` | 汇报材料专家团 (Reporting Team) | 办公文档专家 | 数据分析师, 行业调研专家 |
| `builtin-team:finance-reconciliation` | 财务对账专家团 (Finance Reconciliation Team) | 财务助理 | 数据分析师, 办公文档专家 |
| `builtin-team:recruiting` | 招聘专家团 (Recruiting Team) | HR 招聘官 | 行业调研专家, 办公文档专家 |

These ids do not change after release.
