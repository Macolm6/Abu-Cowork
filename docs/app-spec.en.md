# Abu Apps · Developer Specification

**English** | [中文](app-spec.md)

> Applies to: Abu 0.51.0 and later.
> Related: the [plugin specification](plugin-spec.en.md) (skills, experts, expert teams, connectors); the "Apps" section of the [User Guide](User-Guide.md).

## 1. Terms

| Term | Meaning |
|---|---|
| App | Abu prepared for one kind of work: its own home page, modes, scenes, example prompts and navigation. The user switches apps in the app switcher |
| Scene | One piece of work on the home page, for example "Write a JD". Each scene goes to an expert team, an expert or a skill, and carries 3–6 example prompts |
| Handler | The expert team, expert or skill that does a scene. For example, "Write a JD" goes to the recruiting expert team, so the recruiting expert team is the handler of "Write a JD". On the confirmation page for adding an app, the "Scenes and who handles them" section lists who each scene goes to |
| Plugin | The installation package for skills, experts, expert teams and connectors; its rules are in the [plugin specification](plugin-spec.en.md). An app can use what a plugin brings, and when the user adds the app, the missing plugins are installed along with it |
| Market | A directory that holds one `marketplace.json`, which lists a number of plugins and apps |

Apps and plugins are separate: an app installs no skills, experts, expert teams or connectors and only references them; a plugin has no home page.

## 2. The app directory

| Path | Required | Description |
|---|---|---|
| `.abu-app/app.json` | Required | The app file, see section 3 |
| `assets/` | Optional | The logo and icons; fields in the app file give their paths |

Symbolic links in the directory are not copied.

## 3. The app file `app.json`

The app file and every object in it accept only the fields listed in the tables below. An extra field makes validation fail, and the error points to that field, for example `home.modes.items[0].scenes[0].templetes`. The ids of modes, scenes, templates and navigation items allow only letters, digits, `_` and `-`, and are at most 64 characters long.

### 3.1 Top-level fields

| Field | Required | Type | Description |
|---|---|---|---|
| `name` | Yes | string | The name of the app: lowercase letters, digits and `-`, starting with a letter or a digit, at most 64 characters. The same as the `name` of the market entry |
| `version` | Yes | string | A semantic version number, for example `1.2.0`. Raise it with every release |
| `minAbuVersion` | Yes | string | The lowest Abu version this app requires, `0.51.0` or higher |
| `interface` | Yes | object | Display information, see 3.2 |
| `plugins` | No | string[] | The names of the plugins the app uses. Every plugin that appears in a run reference or in `requiredConnectors` is listed here |
| `home` | Yes | object | The home page, see 3.3 |
| `defaultRun` | No | run reference | Who handles a message the user sends without clicking any scene. When omitted, Abu answers with the app's prompt |
| `promptAppend` | No | string | The app-level prompt, which applies to every conversation in the app. At most 16000 characters |
| `nav` | No | object | Navigation, see 3.5. When omitted, the app keeps Abu's default navigation |
| `allowedOrigins` | Required when there is a `url:` navigation item | string[] | The origins the app's web pages are allowed to use, see 3.6 |
| `requiredConnectors` | No | string[] | `<plugin name>/<connector name>`; the plugin must be listed in `plugins`. While a connector is not connected, the top of the home page prompts the user to connect it |
| `composer.placeholder` | No | LocalizedText | The placeholder text of the input box |

### 3.2 Display information `interface`

| Field | Required | Type | Rule |
|---|---|---|---|
| `displayName` | Yes | LocalizedText | The name in the switcher and in the app market; the text for each language is at most 64 characters |
| `shortDescription` | Yes | LocalizedText | A one-sentence introduction; the text for each language is at most 200 characters |
| `longDescription` | No | LocalizedText | The introduction in the app market details; the text for each language is at most 4000 characters |
| `developerName` | No | string | The developer's name, at most 100 characters |
| `category` | No | string | The category, at most 64 characters |
| `brandColor` | No | string | Must be `#RRGGBB` |
| `logo`, `logoDark` | No | string | Relative paths of images inside the app directory, one for the light interface and one for the dark interface. Required for an app listed in a market |

### 3.3 Home page `home`

| Field | Required | Type | Description |
|---|---|---|---|
| `header.title` | No | LocalizedText | The title of the home page. When omitted, `interface.displayName` is used |
| `header.slogan` | No | LocalizedText | One line of slogan below the title |
| `modes.defaultSelected` | No | string | The mode selected by default; must be one of the `modeId` values |
| `modes.items` | Yes | mode[] | At least 1; 2–4 are recommended. With only 1, the home page shows no mode selection |

Mode:

| Field | Required | Type | Description |
|---|---|---|---|
| `modeId` | Yes | string | Unique within the app |
| `title` | Yes | LocalizedText | The name of the mode |
| `icon` | No | string | The relative path of an image inside the app directory |
| `promptAppend` | No | string | The prompt appended to every conversation in this mode. At most 16000 characters |
| `scenes` | Yes | scene[] | At least 1 |

Scene:

| Field | Required | Type | Description |
|---|---|---|---|
| `id` | Yes | string | Unique within the mode |
| `title` | Yes | LocalizedText | The name of the scene |
| `icon` | No | string | The relative path of an image inside the app directory |
| `run` | No | run reference | Who handles this scene. When omitted, `defaultRun` is used |
| `promptAppend` | No | string | The prompt this scene appends. At most 16000 characters |
| `placeholder` | No | LocalizedText | The placeholder text of the input box after the scene is selected |
| `templates` | Yes | template[] | 3–6 entries |

Template:

| Field | Required | Type | Description |
|---|---|---|---|
| `id` | Yes | string | Unique within the scene |
| `title` | Yes | LocalizedText | The short title shown on the card |
| `prompt` | Yes | LocalizedText | The text put into the input box after a click. The user can edit it before sending |

### 3.4 Run references

A run reference names the expert team or the expert that handles the work. It can also carry a skill, so that the conversation uses this skill from the first message: `{ "team": … }`, `{ "expert": … }`, `{ "team": …, "skill": … }`, `{ "expert": …, "skill": … }`, or `{ "skill": … }` alone.

| Form | Meaning |
|---|---|
| `"team": "builtin-team:<id>"` | An expert team built into Abu; the ids are in [Appendix B of the plugin specification](plugin-spec.en.md#appendix-b--ids-of-the-built-in-expert-teams) |
| `"expert": "builtin:<expert name>"` | An expert built into Abu; the names are in [Appendix A of the plugin specification](plugin-spec.en.md#appendix-a--names-of-the-built-in-experts) |
| `"team": "plugin:<plugin name>/<expert team id>"` | An expert team that a plugin brings |
| `"expert": "plugin:<plugin name>/<expert name>"` | An expert that a plugin brings |
| `"skill": "plugin:<plugin name>/<skill name>"` | A skill that a plugin brings |

Validation fails when a built-in expert team or a built-in expert does not exist, or when the plugin of a `plugin:` reference is not listed in `plugins`. What a plugin brings is checked when the user adds the app: a plugin that is not installed is installed along with the app; an installed version that does not bring what is referenced is updated along with the app.

When a scene points to an expert team, the team's leader handles the conversation. When it points to an expert, this expert handles the conversation. When it points to a skill alone, Abu handles the conversation and uses this skill from the first message.

### 3.5 Navigation `nav`

| Field | Required | Type | Description |
|---|---|---|---|
| `items[].id` | Yes | string | Unique within the navigation |
| `items[].title` | Required for a `url:` navigation item | LocalizedText | A built-in entry without a title uses Abu's own name for it |
| `items[].icon` | No | string | The relative path of an image inside the app directory |
| `items[].order` | No | number | Items are sorted from the lowest value to the highest |
| `items[].target` | Yes | string | See the table below |

| `target` | Meaning |
|---|---|
| `builtin:chat` | New Task. Must appear once |
| `builtin:todos`, `builtin:inbox` | Todos, Inbox |
| `builtin:team` | Experts |
| `builtin:extensions` | Extensions |
| `builtin:automation` | Automation |
| `url:<address>` | A web page of the app itself, shown in the main area. Only `https://` and, for local preview, `http://` are accepted, and the origin must be in `allowedOrigins` |

"Projects", the conversation list and the account menu are not navigation items and stay visible in every app.

### 3.6 App web pages

| Rule | Description |
|---|---|
| Origins | Each entry of `allowedOrigins` is `https://hostname[:port]`; for local preview, `http://127.0.0.1[:port]` or `http://localhost[:port]` is accepted. Wildcards, paths, query parameters and credentials are not accepted |
| `url:` navigation items | The origin of the address must appear in `allowedOrigins` |
| Login redirects | When a web page redirects to another address as it opens (for example the company's login page), add the origin of that address to `allowedOrigins` as well |
| Navigation | When a web page navigates to an address outside `allowedOrigins`, Abu blocks the navigation and opens the address in the system browser |
| New windows | Not allowed. Links open in the system browser |
| Device permissions | Requests for the camera, the microphone, location, notifications and similar permissions are all refused |
| Login state | Stored separately for each app, and cleared when the app is removed |
| Connection to Abu | None. A web page has no access to the user's identity, conversation content or files; Abu does not read the content of the web page either |

Before adding an app that has web page entries, the user sees "This app opens these websites inside Abu" and the list of websites. An app that shows its own interface inside a conversation and passes data between that interface and the conversation uses the interface a connector provides (MCP Apps).

### 3.7 Multilingual text `LocalizedText`

The value is either a string or an object `{ "zh-CN": "…", "en-US": "…" }`. An object holds at least one language; when it has no text for the current interface language, Abu takes `zh-CN` first, then `en-US`.

### 3.8 Example

The "Shop Operations" app, which uses the "Shop Assistant" plugin (excerpt; the complete market is in the repository under `examples/plugin-market/`):

```json
{
  "name": "shop-ops",
  "version": "1.0.0",
  "minAbuVersion": "0.51.0",
  "interface": {
    "displayName": { "zh-CN": "店铺运营", "en-US": "Shop Operations" },
    "shortDescription": { "zh-CN": "选品、详情页、评价回复，一个首页全做完", "en-US": "Product picks, listing pages and review replies from one home page" },
    "logo": "assets/logo.png",
    "logoDark": "assets/logo-dark.png"
  },
  "plugins": ["shop-assistant"],
  "defaultRun": { "team": "plugin:shop-assistant/store-ops" },
  "requiredConnectors": ["shop-assistant/shop-api"],
  "allowedOrigins": ["https://example.com"],
  "home": {
    "modes": {
      "items": [
        {
          "modeId": "listing",
          "title": { "zh-CN": "详情页", "en-US": "Listings" },
          "scenes": [
            {
              "id": "write-listing",
              "title": { "zh-CN": "写详情页", "en-US": "Write a listing" },
              "run": { "skill": "plugin:shop-assistant/product-listing" },
              "templates": [
                { "id": "full", "title": "Full page from specs", "prompt": "Write a complete listing page from these product specs" },
                { "id": "rewrite", "title": "Rewrite the title", "prompt": "Rewrite this product title into three versions that attract more clicks" },
                { "id": "faq", "title": "Add an FAQ", "prompt": "Add the questions buyers ask most about this product, with answers" }
              ]
            }
          ]
        }
      ]
    }
  },
  "nav": {
    "items": [
      { "id": "chat", "target": "builtin:chat", "order": 1 },
      { "id": "portal", "title": { "zh-CN": "店铺后台", "en-US": "Shop portal" }, "target": "url:https://example.com/portal", "order": 2 }
    ]
  }
}
```

For an app that uses only built-in expert teams, see `builtin-plugin-market/apps/recruiting/` in the official market.

## 4. Images

| Use | Field | Format | Recommended size |
|---|---|---|---|
| The app's logo | `interface.logo`, `interface.logoDark` | PNG or SVG | 256×256, transparent background, one for light and one for dark |
| Icons of modes, scenes and navigation items | `icon` | PNG or SVG | 32×32, single-color line art |

All images must be inside the app directory and are referenced by relative paths. An app without a logo shows the first character of its name.

## 5. Apps in a market

### 5.1 `apps` in `marketplace.json`

Apps and plugins are listed in the same `marketplace.json`: plugins under `plugins`, apps under `apps`. The location of the file and its other top-level fields are in [section 12 of the plugin specification](plugin-spec.en.md#12-market-marketplacejson).

| Entry field | Required | Description |
|---|---|---|
| `name` | Yes | The same as the `name` in the app file |
| `source` | Yes | Where the app is fetched from, written the same way as for a plugin entry: a relative path inside the market directory, `url`, or `git-subdir` |
| `version` | Required for a remote source | The same as the `version` in the app file |
| `description` | Required for a remote source | The one-sentence introduction on the app market card, written as `LocalizedText` (see 3.7) |
| `minAbuVersion` | Required for a remote source | The same as the `minAbuVersion` in the app file |

For an app with a relative path, the app market reads the name, the introduction, the logo and the handler of each scene directly from the app file. For an app with a remote source, the app market shows what the entry says, and fetches the whole app when the user clicks "Use".

```json
{
  "name": "acme-apps",
  "owner": { "name": "Acme" },
  "plugins": [
    { "name": "shop-assistant", "version": "1.0.0", "minAbuVersion": "0.51.0", "source": "./plugins/shop-assistant" }
  ],
  "apps": [
    { "name": "shop-ops", "source": "./apps/shop-ops" }
  ]
}
```

### 5.2 Where the plugins an app uses are installed from

When the user adds an app, Abu looks for each plugin in `plugins` that is not installed in the following order and uses the first one it finds:

1. the market the app is in;
2. the official Abu market;
3. the other markets the user has added.

For this reason, the plugins an app uses are best placed in the same market as the app.

### 5.3 Market addresses

The user clicks "Add market" in the app market or the plugin market, and then either enters an address or picks a folder. An address must start with `https://`:

| Address | How Abu fetches it |
|---|---|
| `https://github.com/<owner>/<repository>` | Downloads the archive of the repository's default branch |
| An address ending in `.zip` | Downloads the archive. Everything in the archive sits in one top-level folder |
| Any other address | Clones it as a git repository |

The root of the fetched market must contain `marketplace.json`. When the user opens the app market, Abu checks the time of the last fetch and fetches the market again when more than one hour has passed; when the fetch fails, Abu keeps using the content of the previous fetch. The reasons the user sees when adding a market fails:

| Reason | What the user sees |
|---|---|
| The address requires a login to access | This address needs a login |
| The address has no `marketplace.json`, or its content is invalid | There is no market at this address |
| The user already has a market with the same name | A market with this name already exists; contact whoever gave you the address |

Include your own developer name in the `name` of the market (for example `acme-apps`), so that a customer who adds the markets of two developers gets no name clash.

### 5.4 Updates

For an app the user has already added, the app market shows "Update" when the `version` of this app in the market differs from the added one. Before an update, Abu checks the plugins the app uses in the same way: missing plugins are installed along with it, and plugins whose version is too low are updated along with it. Existing conversations keep running with the configuration they were created with, and new conversations use the new configuration.

When `minAbuVersion` is higher than the user's Abu, the app market shows "Update Abu first" and the app cannot be used.

## 6. Adding from a folder

In the app market, click "Add from folder" and pick an app directory (one that contains `.abu-app/app.json`). Abu copies this directory, validates it and then shows the same confirmation page as for an app from a market. An app added from a folder has no market of its own, so Abu looks for the plugins it uses in steps 2 and 3 of 5.2. Adding an app with the same `name` from a folder again replaces the earlier one. Use this during development to preview your own app.

## 7. Creating an app in a conversation

The user clicks "Create app" in the switcher and describes in the conversation which kind of work the app is for, and Abu writes the app. An app made this way exists only on this user's computer, and its run references can also use these forms:

| Form | Meaning |
|---|---|
| `"team": "mine:<expert team id>"` | An expert team the user created |
| `"expert": "mine:<expert name>"` | An expert the user created |

When new experts or new expert teams are needed, Abu writes them into the draft, and after the user confirms the preview they are created as the user's own experts and expert teams. `mine:` can appear only in this kind of app; an app placed in a market cannot use it.

## 8. Local preview and validation

1. Write `.abu-app/app.json` in the app directory.
2. In Abu's app market, click "Add from folder" and pick the app directory. The confirmation page shows the home page, who each scene goes to, the plugins to be installed along with the app and the web page origins.
3. After the app is added, it appears in the switcher; enter it to see the home page, the navigation and the web pages.
4. After a change, raise `version` and add the app from the folder once more.

When validation fails, the error message gives the full path of the invalid field. Common causes:

| The error points to | Common causes |
|---|---|
| `name` | Uppercase letters, spaces or Chinese characters are used |
| `minAbuVersion` | It is missing; the value is not a semantic version number; it is lower than `0.51.0` |
| `…run.team`, `…run.expert`, `…run.skill` | The form is not in the table of 3.4; the built-in expert team or built-in expert does not exist; the plugin of a `plugin:` reference is not listed in `plugins` |
| `…templates` | Fewer than 3 entries or more than 6 |
| `allowedOrigins` | An origin contains a path or a wildcard, or is not HTTPS |
| `nav.items[n].target` | A `url:` value is neither `https://` nor a local-preview `http://`; the origin is not in `allowedOrigins`; `title` is missing |
| `requiredConnectors[n]` | The value is not `<plugin name>/<connector name>`; the plugin is not listed in `plugins` |
| Any path | A field that is not in the tables is present (in most cases a spelling mistake) |

In the Abu repository you can validate a whole market, with the same rules the official market applies when it accepts an entry:

```bash
npm run market:check -- --dir <market directory>
```

The command also verifies that the `name`, `version` and `minAbuVersion` of each entry match the app file; that the app has `logo` and `logoDark`; that every referenced image is inside the app directory; and that the expert teams, experts and skills of `plugin:` references and the connectors of `requiredConnectors` are in fact brought by that plugin. The plugins an app uses are looked up first in the market being validated, then in the official market.

## 9. Delivering to a customer

1. Put the market directory into a git repository, or pack it into a zip and host it at a downloadable address.
2. Before delivery, in a clean Abu installation, enter this address through "Add market" and click "Use" once, following the customer's steps: the content of the confirmation page is as expected; the plugins to be installed along with the app are installed; every scene can start.
3. Give the address to the customer. The customer clicks "Add market" in the app market, enters the address, finds the app and clicks "Use".
4. To publish a new version, raise the `version` of the app and of the plugins, and update the repository or the archive. When the customer opens the app market and more than one hour has passed since the last fetch, Abu fetches the market again and the app shows "Update".

The customer's Abu cannot fetch an address that requires a login.

## 10. Submitting to the official app market

Submit an app entry to `builtin-plugin-market/` in the Abu repository: write the source as `git-subdir` or `url` and pin a `sha`; fill in `version`, `description` and `minAbuVersion`. The plugins the app uses must be in the official market. The Abu team reviews the entry manually against the web page rules of section 3.6, the security rules of section 10 of the plugin specification and the checklist of section 11 of this specification. After `npm run market:check` passes, the app enters the official market with the next Abu version. For an update, submit the new `sha`; the entry is reviewed again.

## 11. Checklist before submission

- [ ] The app file has `name`, `version`, `minAbuVersion`, `interface.displayName`, `interface.shortDescription`, `interface.logo` and `interface.logoDark`.
- [ ] Every scene has 3–6 templates, and the `prompt` of each template can be sent as it is once the user clicks it.
- [ ] The expert team, expert or skill each `run` points to exists; every plugin used is listed in `plugins` and is in the same market or in the official market.
- [ ] When there is a `url:` navigation item, `allowedOrigins` is complete, including the login page a web page redirects to as it opens.
- [ ] All images are inside the app directory, and the logo has a light and a dark version.
- [ ] `npm run market:check -- --dir <market directory>` passes.
- [ ] The steps of section 9, step 2 have been run once in a clean Abu installation.
