// Documentation page: reads the Markdown guides and the release notes, switches between them, builds the contents list.
(function () {
  const zh = document.documentElement.lang.toLowerCase().indexOf('zh') === 0;
  // A guide is a Markdown file of the site. The release notes are the changelog in this page's language,
  // up to the version the release record names.
  const DOCS = zh
    ? {
        'installation': { file: 'docs/Installation-Guide.zh-CN.md', title: '安装指南' },
        'user-guide': { file: 'docs/User-Guide.zh-CN.md', title: '使用指南' },
        'web-browsing': { file: 'docs/browser-bridge-vs-playwright.zh-CN.md', title: '浏览网页' },
        'app-spec': { file: 'docs/app-spec.md', title: '应用规范' },
        'plugin-spec': { file: 'docs/plugin-spec.md', title: '插件规范' },
        'changelog': { changelog: 'docs/release-notes.zh-CN.md', title: '更新日志' },
      }
    : {
        'installation': { file: 'docs/Installation-Guide.md', title: 'Installation Guide' },
        'user-guide': { file: 'docs/User-Guide.md', title: 'User Guide' },
        'web-browsing': { file: 'docs/browser-bridge-vs-playwright.md', title: 'Web Browsing' },
        'app-spec': { file: 'docs/app-spec.en.md', title: 'App Spec' },
        'plugin-spec': { file: 'docs/plugin-spec.en.md', title: 'Plugin Spec' },
        'changelog': { changelog: 'docs/release-notes.md', title: 'Release notes' },
      };
  const DEFAULT_DOC = 'installation';
  const RELEASE_METADATA = 'https://abu-agent.oss-cn-beijing.aliyuncs.com/electron/latest-release.json';
  const TEXT = zh
    ? {
        loading: '正在读取文档',
        failed: (title) => `「${title}」没有读取成功。`,
        retry: '重新读取',
        contents: '本页目录',
        versions: '版本',
        pageTitle: (title) => `${title} - Abu (阿布)`,
      }
    : {
        loading: 'Loading the document',
        failed: (title) => `“${title}” could not be loaded.`,
        retry: 'Try again',
        contents: 'On this page',
        versions: 'Versions',
        pageTitle: (title) => `${title} — Abu`,
      };

  const layout = document.getElementById('docs');
  const article = document.getElementById('article');
  const state = document.getElementById('docsState');
  const toc = document.getElementById('toc');
  const rail = document.getElementById('contents');
  const side = document.getElementById('docsSide');
  const menu = document.getElementById('docsMenu');
  let headingCounts = {};
  let spy = null;
  let loadCount = 0;
  let currentDoc = null;

  // A version heading of the changelog reads "v0.50.0 · 2026-09-16"; its number is also its address on the page.
  const VERSION_HEADING = /^(v(\d+)\.(\d+)\.(\d+))(?:\s*·\s*(\S+))?/;
  const VERSION_HASH = /^v\d+\.\d+\.\d+$/;
  function versionNumbers(text) {
    const match = VERSION_HEADING.exec(text);
    return match ? [Number(match[2]), Number(match[3]), Number(match[4])] : null;
  }
  function isReleased(numbers, latest) {
    for (let i = 0; i < 3; i += 1) {
      if (numbers[i] !== latest[i]) return numbers[i] < latest[i];
    }
    return true;
  }

  function slugify(text) {
    return text.toLowerCase().replace(/[^\w一-鿿\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
  }

  const renderer = new window.marked.Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const text = tokens.map((t) => t.raw || t.text || '').join('');
    let slug = slugify(text);
    headingCounts[slug] = (headingCounts[slug] || 0) + 1;
    if (headingCounts[slug] > 1) slug += '-' + headingCounts[slug];
    return `<h${depth} id="${slug}">${this.parser.parseInline(tokens)}</h${depth}>`;
  };
  renderer.table = function ({ header, rows }) {
    const cell = (tag, item) => {
      const align = item.align ? ` style="text-align:${item.align}"` : '';
      return `<${tag}${align}>${this.parser.parseInline(item.tokens)}</${tag}>`;
    };
    const head = header.map((item) => cell('th', item)).join('');
    const body = rows.map((row) => `<tr>${row.map((item) => cell('td', item)).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  };
  window.marked.use({ gfm: true, breaks: false, renderer });

  // The part of the address after # names either a guide or a heading inside the current guide.
  // Old public links to #browser-bridge open the guide under its current name.
  function docFromHash() {
    const hash = decodeURIComponent(location.hash.slice(1));
    const key = hash === 'browser-bridge' ? 'web-browsing' : hash;
    if (hash === 'browser-bridge') history.replaceState(null, '', '#web-browsing');
    return DOCS[key] ? key : null;
  }

  // A guide's file name without its language mark: User-Guide.zh-CN.md and app-spec.en.md name the guides User-Guide.md and app-spec.md.
  function plainName(file) {
    return file.replace(/\.(?:zh-CN|en)\.md$/, '.md');
  }

  function showState(...nodes) {
    state.replaceChildren(...nodes);
    state.hidden = false;
  }

  // Both readers resolve to the document's HTML or, when the source cannot be read, to null.
  function readText(file) {
    return fetch(file).then((resp) => (resp.ok ? resp.text() : null), () => null);
  }

  function readGuide(doc) {
    return readText(doc.file).then((markdown) => {
      if (markdown === null) return null;
      headingCounts = {};
      return window.marked.parse(markdown);
    });
  }

  function readLatestVersion() {
    return fetch(RELEASE_METADATA, { cache: 'no-cache' })
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((data) => (data && data.schema_version === 1 ? versionNumbers(data.version || '') : null))
      .catch(() => null);
  }

  // The changelog file opens with notes for maintainers and a section of changes that are not released yet.
  // The page shows the sections of the released versions: each runs from its version heading to the next one.
  async function readReleaseNotes(doc) {
    const [latest, markdown] = await Promise.all([readLatestVersion(), readText(doc.changelog)]);
    if (latest === null || markdown === null) return null;
    const tokens = window.marked.lexer(markdown);
    const shown = [];
    let keep = false;
    for (const token of tokens) {
      if (token.type === 'heading' && token.depth <= 2) {
        const numbers = token.depth === 2 ? versionNumbers(token.text) : null;
        keep = numbers !== null && isReleased(numbers, latest);
      }
      if (keep) shown.push(token);
    }
    if (!shown.length) return null;
    shown.links = tokens.links;
    headingCounts = {};
    return window.marked.parser(shown);
  }

  async function loadDoc(key, headingId) {
    const doc = DOCS[key];
    const load = ++loadCount;
    currentDoc = key;
    document.querySelectorAll('.doc-link').forEach((el) => {
      if (el.dataset.doc === key) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    article.replaceChildren();
    toc.replaceChildren();
    rail.replaceChildren();
    layout.classList.remove('has-rail');
    spy = null;
    showState(TEXT.loading);

    // A document that cannot be read shows a message with a retry button in place of the text.
    const html = await (doc.changelog ? readReleaseNotes(doc) : readGuide(doc));
    if (load !== loadCount) return;
    if (html === null) {
      const message = document.createElement('p');
      message.textContent = TEXT.failed(doc.title);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-line btn-sm';
      retry.textContent = TEXT.retry;
      retry.addEventListener('click', () => loadDoc(key));
      showState(message, retry);
      return;
    }

    article.innerHTML = html;
    state.hidden = true;
    document.title = TEXT.pageTitle(doc.title);

    // The release notes carry no title of their own: the page adds one. Each version heading takes its number as its address.
    if (doc.changelog) {
      const title = document.createElement('h1');
      title.textContent = doc.title;
      article.prepend(title);
      article.querySelectorAll('h2').forEach((h) => { h.id = VERSION_HEADING.exec(h.textContent)[1]; });
    }

    // Each guide opens with a line linking to its other-language file; the page has its own language link.
    const opener = article.querySelector('h1 + p');
    if (opener && /^(English|中文)\s*\|\s*(English|中文)$/.test(opener.textContent.trim())) opener.remove();

    // Keep links between Markdown guides inside the single-page docs viewer; outside links open in a new tab.
    article.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href').replace(/^\.\//, '');
      // A link may name a heading of the other guide, or the guide's file in the other language.
      const file = plainName(href.split('#')[0]);
      const target = file && Object.entries(DOCS).find(([, candidate]) => candidate.file && plainName(candidate.file).endsWith('/' + file));
      if (target) link.setAttribute('href', '#' + target[0]);
      else if (/^https?:/.test(href)) { link.target = '_blank'; link.rel = 'noopener'; }
    });

    buildContents(doc);
    const heading = headingId && document.getElementById(headingId);
    if (heading) heading.scrollIntoView();
    else scrollTo(0, 0);
    markCurrentHeading();
  }

  // The contents of the document in view show beside the text on a wide window, and in the side column on a narrow one.
  // A guide lists its sections; the release notes list their versions, each with its date.
  function buildContents(doc) {
    const headings = [...article.querySelectorAll(doc.changelog ? 'h2' : 'h2, h3')];
    if (!headings.length) return;
    for (const list of [rail, toc]) {
      const label = document.createElement('span');
      label.className = 'eyebrow';
      label.textContent = doc.changelog ? TEXT.versions : TEXT.contents;
      list.append(label);
      for (const h of headings) {
        const a = document.createElement('a');
        a.className = 'toc-link' + (h.tagName === 'H3' ? ' is-h3' : '');
        a.href = '#' + h.id;
        a.dataset.heading = h.id;
        if (doc.changelog) {
          const [, version, , , , date] = VERSION_HEADING.exec(h.textContent);
          a.textContent = version;
          if (date) {
            const day = document.createElement('span');
            day.className = 'toc-date';
            day.textContent = date;
            a.append(day);
          }
        } else {
          a.textContent = h.textContent;
        }
        list.append(a);
      }
    }
    layout.classList.add('has-rail');
    spy = headings;
  }

  // The contents list marks the heading being read: the last one that has scrolled up to the navigation bar.
  function markCurrentHeading() {
    if (!spy) return;
    let current = spy[0];
    for (const h of spy) {
      if (h.getBoundingClientRect().top <= 120) current = h;
    }
    layout.querySelectorAll('.toc-link').forEach((el) => el.classList.toggle('is-active', el.dataset.heading === current.id));
  }
  addEventListener('scroll', markCurrentHeading, { passive: true });

  // An address that names a version opens the release notes at that version.
  addEventListener('hashchange', () => {
    const hash = decodeURIComponent(location.hash.slice(1));
    const key = docFromHash();
    if (key) loadDoc(key);
    else if (VERSION_HASH.test(hash) && currentDoc !== 'changelog') loadDoc('changelog', hash);
    side.classList.remove('is-open');
    menu.setAttribute('aria-expanded', 'false');
  });
  menu.addEventListener('click', () => {
    const open = side.classList.toggle('is-open');
    menu.setAttribute('aria-expanded', String(open));
  });

  const firstDoc = docFromHash();
  const firstHash = decodeURIComponent(location.hash.slice(1));
  loadDoc(firstDoc || (VERSION_HASH.test(firstHash) ? 'changelog' : DEFAULT_DOC), firstDoc ? null : firstHash);
})();
