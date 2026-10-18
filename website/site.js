// Shared by every page: the navigation bar's states and the entrance of content.
(function () {
  const nav = document.getElementById('nav');
  const nights = [...document.querySelectorAll('[data-night]')];
  let queued = false;

  // The bar stays at the top of the window. Away from the top of the page it gets a background and a rule; over a dark block it turns dark.
  function update() {
    nav.classList.toggle('is-solid', nav.hasAttribute('data-solid') || scrollY > 24);
    const onNight = nights.some((el) => {
      const r = el.getBoundingClientRect();
      return r.top <= 36 && r.bottom >= 36;
    });
    nav.classList.toggle('on-night', onNight);
  }

  function request() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }
  addEventListener('scroll', request, { passive: true });
  addEventListener('resize', request);
  update();

  // Below 1040px the bar has no room for its entries: a menu button opens them as a page over the whole window.
  const links = nav.querySelector('.nav-links');
  const cta = nav.querySelector('.nav-cta');
  const zh = document.documentElement.lang.startsWith('zh');
  const labels = zh ? { open: '菜单', close: '关闭菜单' } : { open: 'Menu', close: 'Close menu' };
  const menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.className = 'nav-menu';
  menuButton.setAttribute('aria-controls', 'navSheet');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', labels.open);
  menuButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">'
    + '<path class="open" d="M4 8h16M4 16h16"/><path class="close" d="M6 6l12 12M18 6L6 18"/></svg>';
  cta.append(menuButton);

  const sheet = document.createElement('div');
  sheet.className = 'nav-sheet';
  sheet.id = 'navSheet';
  sheet.hidden = true;
  const sheetNav = document.createElement('nav');
  sheetNav.setAttribute('aria-label', links.getAttribute('aria-label'));
  for (const link of links.querySelectorAll('a')) sheetNav.append(link.cloneNode(true));
  const github = cta.querySelector('a[href^="https://github.com/"]');
  const githubLink = github.cloneNode(true);
  githubLink.className = 'nav-sheet-github';
  sheetNav.append(githubLink);
  sheet.append(sheetNav);
  nav.after(sheet);

  function setMenu(open) {
    if (open === !sheet.hidden) return;
    sheet.hidden = !open;
    nav.classList.toggle('is-open', open);
    document.documentElement.classList.toggle('nav-locked', open);
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? labels.close : labels.open);
    // While the menu covers the page, the page under it takes no focus and is not read.
    for (const el of document.body.children) {
      if (el !== nav && el !== sheet && el.tagName !== 'SCRIPT') el.inert = open;
    }
  }
  menuButton.addEventListener('click', () => setMenu(sheet.hidden));
  sheet.addEventListener('click', (event) => {
    if (event.target.closest('a')) setMenu(false);
  });
  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || sheet.hidden) return;
    setMenu(false);
    menuButton.focus();
  });
  matchMedia('(min-width: 1041px)').addEventListener('change', (event) => {
    if (event.matches) setMenu(false);
  });

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach((el, i) => {
    el.style.transitionDelay = `${(i % 4) * 70}ms`;
    observer.observe(el);
  });

  // Star count beside the repository's name, on the pages that have a place for it.
  // The count comes from GitHub's public API; when it cannot be read the place stays empty.
  const stars = document.getElementById('stars');
  if (stars) {
    fetch('https://api.github.com/repos/PM-Shawn/Abu-Cowork')
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((repo) => {
        if (!repo) return;
        stars.textContent = `★ ${repo.stargazers_count.toLocaleString('en-US')}`;
        stars.hidden = false;
      })
      .catch(() => {});
  }
})();
