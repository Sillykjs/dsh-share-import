// dsh-share-import — browser half (client plugin module).
//
// Adds the "Share import" page (DeepSeek and Doubao share links) to the DSH Web
// settings panel and the sidebar navigation
// (`settings.section`, id `dsh-share-import`). It talks to the host half through
// same-origin JSON routes (`/__dsh-share-import/*`): list workspaces, preview a
// pasted share link, then import it into the chosen workspace as a static,
// resumable DSH session.
//
// Copy is localized: every visible string comes from `MESSAGES` (Chinese and
// English) and is registered into the Host locale namespace when the composition
// provides `ctx.locale`, so the page follows the Host/browser language and falls
// back to English (the locale registry's own fallback).
//
// Client plugin entry: exports a Cordis plugin (`apply` + `inject`); the loader
// wrapper (`window.__ModuleLoader__.load`) resolves `react` through the module
// table and calls `apply` once the `slots` service is available.
window.__ModuleLoader__.load({
  id: 'dsh-share-import',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    //#region
    const React = require('react');

    const NS = 'dsh-share-import';
    /** Main-panel id shared by the sidebar nav row and the panel body. */
    const PANEL_ID = 'share-import';
    /** Whether the sidebar nav row is shown; kept in this browser's local storage. */
    const NAV_PREF_KEY = 'dsh-share-import:show-nav';

    function readNavPref() {
      try {
        const stored = window.localStorage.getItem(NAV_PREF_KEY);
        return stored === null ? true : stored !== '0';
      } catch (error) {
        return true;
      }
    }

    function writeNavPref(visible) {
      try {
        window.localStorage.setItem(NAV_PREF_KEY, visible ? '1' : '0');
      } catch (error) {
        /* private mode: the choice lasts for this page only */
      }
    }

    const DICT_ZH = {
      nav: '分享导入',
      panel: '分享导入',
      panelTitle: '导入 DeepSeek / 豆包分享链接',
      back: '回到对话',
      navToggle: '在导航区显示入口',
      navToggleHint: '关闭后导航区不再出现分享导入，本页仍可从设置进入。',
      heading: '从 DeepSeek 或豆包分享链接导入会话',
      intro: '粘贴一个公开的网页端 DeepSeek（chat.deepseek.com）分享链接或豆包（doubao.com）分享链接，选择一个工作区，插件会把这段问答写成该工作区里的一个 DSH 会话。注意：只保留文字，图片和附件等不会导入。',
      linkLabel: '分享链接',
      linkPlaceholder: 'https://chat.deepseek.com/share/… 或 https://www.doubao.com/thread/…',
      workspaceLabel: '导入到工作区',
      preview: '预览',
      importing: '导入中…',
      doImport: '导入会话',
      importAgain: '仍然导入为新会话',
      previewTitle: '预览',
      rounds: '轮问答',
      droppedTail: '末尾有一条提问没有回答，已跳过',
      firstQuestion: '第一条问题',
      lastQuestion: '最后一条问题',
      already: '这个分享以前导入过（会话 ',
      alreadyTail: '）；再次导入会新建一个会话。',
      success: '导入完成',
      sessionTitle: '会话标题',
      sessionId: '会话 ID',
      events: '事件',
      attachedFailed: '会话已写入，但没有挂到工作区列表：刷新页面后重试一次',
      refreshHint: '侧边栏已刷新；如果没看到，请在对应工作区的会话列表里找这个标题。',
      emptyWorkspaces: '还没有工作区。请先在 DSH 里创建一个工作区，再回来导入。',
      errLink: '请先粘贴分享链接',
      errWorkspace: '请选择工作区',
      errGeneric: '操作失败：',
      errNet: '无法连接本机服务：',
      codeInvalidLink: '链接无效：支持 https://chat.deepseek.com/share/… 和 https://www.doubao.com/thread/… 两种分享链接',
      codeNotFound: '分享不存在或已被删除',
      codeFetch: '无法获取分享内容，请检查网络或链接是否仍公开',
      codeMalformed: '分享内容格式不正确（可能已过期）',
      codeLazy: '这个豆包分享需要登录才能加载完整内容，暂不支持导入',
      codeEmpty: '这个分享里没有可导入的问答',
      codeAlready: '这个分享以前导入过',
      codeNoWorkspaces: '当前实例没有可用的工作区注册表',
      codeNoPersistence: '当前实例没有可用的会话持久化服务',
      codeWrite: '写入会话失败',
      codeVerify: '会话写入后读不回来（格式不兼容）',
      codeInternal: '内部错误',
      retryHint: '如果你最近升级过 DSH，请把错误码和上面的提示一起反馈。',
    };

    const DICT_EN = {
      nav: 'Share import',
      panel: 'Share import',
      panelTitle: 'Import from a DeepSeek or Doubao share link',
      back: 'Back to conversation',
      navToggle: 'Show the entry in the sidebar nav',
      navToggleHint: 'When off, the sidebar hides Share import; this page stays reachable from Settings.',
      heading: 'Import a session from a DeepSeek or Doubao share link',
      intro: 'Paste a public DeepSeek web share link (chat.deepseek.com) or a Doubao (doubao.com) share link and pick a workspace. The plugin writes that Q&A into a DSH session inside that workspace. Note: text only — images, attachments and the like are not imported.',
      linkLabel: 'Share link',
      linkPlaceholder: 'https://chat.deepseek.com/share/… or https://www.doubao.com/thread/…',
      workspaceLabel: 'Import into workspace',
      preview: 'Preview',
      importing: 'Importing…',
      doImport: 'Import session',
      importAgain: 'Import again as a new session',
      previewTitle: 'Preview',
      rounds: 'rounds',
      droppedTail: 'The last question has no answer and was skipped',
      firstQuestion: 'First question',
      lastQuestion: 'Last question',
      already: 'This share was imported before (session ',
      alreadyTail: '). Importing again creates a new session.',
      success: 'Imported',
      sessionTitle: 'Title',
      sessionId: 'Session id',
      events: 'events',
      attachedFailed: 'The session was written but not attached to the workspace list; reload and try again',
      refreshHint: 'The sidebar was refreshed; if the session is not visible, look for this title under the chosen workspace.',
      emptyWorkspaces: 'No workspace yet. Create one in DSH first, then come back.',
      errLink: 'Paste a share link first',
      errWorkspace: 'Choose a workspace',
      errGeneric: 'Failed: ',
      errNet: 'Cannot reach the local service: ',
      codeInvalidLink: 'Invalid link: use a https://chat.deepseek.com/share/… or https://www.doubao.com/thread/… share link',
      codeNotFound: 'The share does not exist or was deleted',
      codeFetch: 'Could not fetch the share; check the network or whether the link is still public',
      codeMalformed: 'The share payload has an unexpected shape (it may have expired)',
      codeLazy: 'This Doubao share needs a login to load its full content and cannot be imported yet',
      codeEmpty: 'This share has no importable Q&A',
      codeAlready: 'This share was imported before',
      codeNoWorkspaces: 'This instance has no workspace registry',
      codeNoPersistence: 'This instance has no session persistence service',
      codeWrite: 'Writing the session failed',
      codeVerify: 'The session could not be read back (format mismatch)',
      codeInternal: 'Internal error',
      retryHint: 'If you upgraded DSH recently, report the code above together with this message.',
    };

    /** Browser language reduced to its primary subtag (`zh-CN` -> `zh`). */
    function browserLanguage() {
      try {
        const raw = (typeof navigator !== 'undefined' && (navigator.language || (navigator.languages || [])[0])) || '';
        return String(raw).toLowerCase().split('-')[0];
      } catch (error) {
        return '';
      }
    }

    /** Stand-in translator for compositions without `ctx.locale`. */
    function t(key) {
      const prefer = browserLanguage() === 'zh' ? DICT_ZH : DICT_EN;
      if (prefer[key] !== undefined) return prefer[key];
      return DICT_EN[key] !== undefined ? DICT_EN[key] : key;
    }

    /** Call one host route and parse its JSON response. */
    function call(method, args) {
      return fetch('/__dsh-share-import/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      }).then((res) => res.json()).catch((error) => ({
        ok: false,
        code: 'NETWORK',
        message: error instanceof Error ? error.message : String(error),
      }));
    }

    /** Localized text for one host failure. */
    function describeErr(translate, result) {
      if (!result) return translate('errGeneric') + translate('codeInternal');
      const code = typeof result.code === 'string' ? result.code : '';
      const known = {
        SHARE_LINK_INVALID: 'codeInvalidLink',
        SHARE_NOT_FOUND: 'codeNotFound',
        SHARE_FETCH_FAILED: 'codeFetch',
        SHARE_MALFORMED: 'codeMalformed',
        SHARE_EMPTY: 'codeEmpty',
        SHARE_LAZY: 'codeLazy',
        ALREADY_IMPORTED: 'codeAlready',
        WORKSPACES_UNAVAILABLE: 'codeNoWorkspaces',
        PERSISTENCE_UNAVAILABLE: 'codeNoPersistence',
        WRITE_FAILED: 'codeWrite',
        VERIFY_FAILED: 'codeVerify',
        INTERNAL: 'codeInternal',
        NETWORK: 'errNet',
      };
      const key = known[code];
      const detail = result.message === undefined || result.message === null ? '' : String(result.message);
      if (key !== undefined) {
        const base = translate(key);
        if (code === 'NETWORK' || code === 'SHARE_LINK_INVALID' || code === 'SHARE_FETCH_FAILED'
          || code === 'WRITE_FAILED' || code === 'VERIFY_FAILED') {
          return detail.length > 0 && detail !== base ? base + '（' + detail + '）' : base;
        }
        return base;
      }
      return translate('errGeneric') + (code.length > 0 ? code : '?') + (detail.length > 0 ? ' · ' + detail : '');
    }

    const CSS = [
      '.dssi{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.55;max-width:760px}',
      '.dssi h2{margin:0;font-size:16px;font-weight:600}',
      '.dssi-intro{color:var(--color-text-secondary,#777);margin:0}',
      '.dssi-card{border:1px solid var(--color-border,#e2e2e2);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.dssi-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dssi-label{min-width:96px;color:var(--color-text-secondary,#777)}',
      '.dssi-input,.dssi-select{flex:1;min-width:220px;padding:6px 8px;border-radius:6px;border:1px solid var(--color-border,#ccc);background:var(--color-bg-input,#fff);color:inherit;font:inherit}',
      '.dssi-btn{padding:6px 14px;border-radius:6px;border:1px solid var(--color-border,#ccc);background:transparent;color:inherit;cursor:pointer;font:inherit}',
      '.dssi-btn:disabled{opacity:.5;cursor:default}',
      '.dssi-primary{background:var(--color-accent,#4d6bfe);border-color:transparent;color:#fff}',
      '.dssi-note{color:var(--color-text-secondary,#777);margin:0}',
      '.dssi-toggle{display:flex;align-items:center;gap:8px;cursor:pointer}',
      '.dssi-toggle input{appearance:none;-webkit-appearance:none;flex:none;position:relative;width:36px;height:20px;margin:0;border-radius:999px;background:var(--color-border,#ccc);cursor:pointer;transition:background .15s}',
      '.dssi-toggle input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}',
      '.dssi-toggle input:checked{background:var(--color-accent,#4d6bfe)}',
      '.dssi-toggle input:checked::after{left:18px}',
      '.dssi-err{color:#c0392b;margin:0;white-space:pre-wrap}',
      '.dssi-kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}',
      '.dssi-kv dt{color:var(--color-text-secondary,#777)}',
      '.dssi-kv dd{margin:0;word-break:break-all}',
      '.dssi-tag{display:inline-block;padding:1px 8px;border-radius:999px;background:rgba(77,107,254,.12);color:#4d6bfe;font-size:12px}',
      '.dssi-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.dssi-page{display:flex;flex-direction:column;gap:14px;height:100%;overflow:auto;padding:20px 24px 28px;box-sizing:border-box}',
      '.dssi-pagehead{display:flex;align-items:center;gap:12px;min-height:28px}',
      '.dssi-pagehead h1{margin:0;font-size:18px;font-weight:600;flex:1;min-width:0}',
      '.dssi-back{padding:4px 10px;border-radius:6px;border:1px solid var(--color-border,#ccc);background:transparent;color:var(--color-text-secondary,#777);cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}',
      '.dssi-back:hover{color:inherit}',
      '.dssi-icon{display:block;width:100%;height:100%}',
    ].join('\n');

    /** Reusable label + input row. */
    function Row(props) {
      return React.createElement('div', { className: 'dssi-row' },
        React.createElement('span', { className: 'dssi-label' }, props.label),
        props.children);
    }

    /** The settings page. */
    function App(props) {
      const translate = props.t || t;
      const refreshSessions = typeof props.refreshSessions === 'function' ? props.refreshSessions : () => {};
      const [link, setLink] = React.useState('');
      const [workspaces, setWorkspaces] = React.useState([]);
      const [workspaceId, setWorkspaceId] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [preview, setPreview] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [force, setForce] = React.useState(false);
      const [navVisible, setNavVisible] = React.useState(() => readNavPref());

      React.useEffect(() => {
        let alive = true;
        call('workspaces', {}).then((answer) => {
          if (!alive) return;
          if (answer && answer.ok) {
            const list = Array.isArray(answer.workspaces) ? answer.workspaces : [];
            setWorkspaces(list);
            setWorkspaceId((current) => current || (list[0] ? list[0].id : ''));
          } else {
            setError(describeErr(translate, answer));
          }
        });
        return () => { alive = false; };
      }, []);

      const resetOutcome = () => {
        setResult(null);
        setForce(false);
        setError('');
        setPreview(null);
      };

      const onPreview = () => {
        if (busy !== '') return;
        resetOutcome();
        if (link.trim() === '') { setError(translate('errLink')); return; }
        setBusy('preview');
        call('preview', { link }).then((answer) => {
          setBusy('');
          if (answer && answer.ok) setPreview(answer);
          else setError(describeErr(translate, answer));
        });
      };

      const onImport = () => {
        if (busy !== '') return;
        if (workspaceId === '') { setError(translate('errWorkspace')); return; }
        setBusy('import');
        setError('');
        call('import', { link, workspaceId, force }).then((answer) => {
          setBusy('');
          if (answer && answer.ok) {
            setResult(answer);
            setForce(false);
            refreshSessions();
            return;
          }
          if (answer && answer.code === 'ALREADY_IMPORTED') {
            setForce(true);
            setError(describeErr(translate, answer));
            return;
          }
          setError(describeErr(translate, answer));
        });
      };

      const onNavToggle = (next) => {
        setNavVisible(next);
        if (typeof props.onToggleNav === 'function') props.onToggleNav(next);
      };

      const children = [];
      if (props.hideHeading !== true) children.push(React.createElement('h2', { key: 'h' }, translate('heading')));
      children.push(React.createElement('p', { className: 'dssi-intro', key: 'i' }, translate('intro')));

      if (props.showNavToggle === true) {
        children.push(React.createElement('div', { className: 'dssi-card', key: 'n' },
          React.createElement('label', { className: 'dssi-toggle' },
            React.createElement('input', {
              type: 'checkbox',
              checked: navVisible,
              onChange: (event) => onNavToggle(event.target.checked),
            }),
            React.createElement('span', null, translate('navToggle'))),
          React.createElement('p', { className: 'dssi-note' }, translate('navToggleHint'))));
      }

      const card = React.createElement('div', { className: 'dssi-card', key: 'c' },
        React.createElement(Row, { label: translate('linkLabel') },
          React.createElement('input', {
            className: 'dssi-input dssi-mono',
            type: 'url',
            spellCheck: false,
            placeholder: translate('linkPlaceholder'),
            value: link,
            onChange: (event) => { setLink(event.target.value); setPreview(null); setResult(null); setError(''); },
          })),
        React.createElement(Row, { label: translate('workspaceLabel') },
          React.createElement('select', {
            className: 'dssi-select',
            value: workspaceId,
            onChange: (event) => setWorkspaceId(event.target.value),
          }, workspaces.length === 0
            ? React.createElement('option', { value: '' }, translate('emptyWorkspaces'))
            : workspaces.map((workspace) => React.createElement('option', { key: workspace.id, value: workspace.id },
              workspace.title + (workspace.path ? '  —  ' + workspace.path : ''))))),
        React.createElement('div', { className: 'dssi-row' },
          React.createElement('button', {
            className: 'dssi-btn',
            type: 'button',
            disabled: busy !== '' || link.trim() === '',
            onClick: onPreview,
          }, busy === 'preview' ? translate('preview') + '…' : translate('preview')),
          React.createElement('button', {
            className: 'dssi-btn dssi-primary',
            type: 'button',
            disabled: busy !== '' || link.trim() === '' || workspaceId === '',
            onClick: onImport,
          }, busy === 'import' ? translate('importing') : (force ? translate('importAgain') : translate('doImport')))));
      children.push(card);

      if (preview !== null) {
        const rows = [
          React.createElement('dt', { key: 't' }, translate('sessionTitle')),
          React.createElement('dd', { key: 'tv' }, preview.title),
          React.createElement('dt', { key: 'r' }, translate('rounds')),
          React.createElement('dd', { key: 'rv' }, String(preview.rounds)),
        ];
        if (preview.firstQuestion) {
          rows.push(React.createElement('dt', { key: 'f' }, translate('firstQuestion')));
          rows.push(React.createElement('dd', { key: 'fv', className: 'dssi-note' }, preview.firstQuestion));
        }
        if (preview.lastQuestion && preview.lastQuestion !== preview.firstQuestion) {
          rows.push(React.createElement('dt', { key: 'l' }, translate('lastQuestion')));
          rows.push(React.createElement('dd', { key: 'lv', className: 'dssi-note' }, preview.lastQuestion));
        }
        children.push(React.createElement('div', { className: 'dssi-card', key: 'p' },
          React.createElement('div', { className: 'dssi-row' },
            React.createElement('span', { className: 'dssi-tag' }, translate('previewTitle'))),
          React.createElement('dl', { className: 'dssi-kv' }, rows),
          preview.droppedTail > 0
            ? React.createElement('p', { className: 'dssi-note' }, translate('droppedTail'))
            : null,
          preview.alreadyImported
            ? React.createElement('p', { className: 'dssi-note' },
              translate('already') + String(preview.existingSessionId || '?') + translate('alreadyTail'))
            : null));
      }

      if (result !== null) {
        children.push(React.createElement('div', { className: 'dssi-card', key: 'r' },
          React.createElement('div', { className: 'dssi-row' },
            React.createElement('span', { className: 'dssi-tag' }, translate('success'))),
          React.createElement('dl', { className: 'dssi-kv' },
            React.createElement('dt', null, translate('sessionTitle')),
            React.createElement('dd', null, result.title),
            React.createElement('dt', null, translate('sessionId')),
            React.createElement('dd', { className: 'dssi-mono' }, result.sessionId),
            React.createElement('dt', null, translate('events')),
            React.createElement('dd', null, String(result.eventCount))),
          result.attached === false
            ? React.createElement('p', { className: 'dssi-err' }, translate('attachedFailed'))
            : React.createElement('p', { className: 'dssi-note' }, translate('refreshHint'))));
      }

      if (error !== '') {
        children.push(React.createElement('div', { key: 'e' },
          React.createElement('p', { className: 'dssi-err' }, error),
          React.createElement('p', { className: 'dssi-note' }, translate('retryHint'))));
      }

      return React.createElement('div', { className: 'dssi' }, children);
    }

    /** Nav-row glyph: an arrow dropping into a tray (import). */
    function PanelIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18;
      return React.createElement('svg', {
        className: 'dssi-icon',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        React.createElement('path', { d: 'M12 3v10' }),
        React.createElement('path', { d: 'M8 9l4 4 4-4' }),
        React.createElement('path', { d: 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3' }));
    }

    /** The main-column page reached from the sidebar nav row. */
    function PanelPage(props) {
      const translate = props.t || t;
      const back = typeof props.onClose === 'function' ? props.onClose : null;
      return React.createElement('section', {
        className: 'dssi-page',
        'aria-label': translate('panelTitle'),
        'data-testid': 'share-import-page',
      },
        React.createElement('div', { className: 'dssi-pagehead' },
          React.createElement('h1', null, translate('panelTitle')),
          back !== null
            ? React.createElement('button', {
              className: 'dssi-back',
              type: 'button',
              onClick: back,
            }, translate('back'))
            : null),
        React.createElement(App, {
          t: translate,
          hideHeading: true,
          refreshSessions: props.refreshSessions,
        }));
    }

    /**
     * Settings nav rows draw a shell-owned icon chosen from the section id; an
     * unknown id falls back to the gear. Repaint just our row with a download
     * glyph (the shell re-renders rows, so re-check through a mutation observer).
     */
    function installSettingsNavIcon(label) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
      let timer = 0;
      const paint = () => {
        timer = 0;
        const dialog = document.querySelector('[data-shortcut-modal="settings"]');
        if (dialog === null) return;
        const wanted = label().trim();
        if (wanted === '') return;
        const buttons = dialog.querySelectorAll('nav button');
        for (const button of buttons) {
          const text = button.textContent === null ? '' : button.textContent.trim();
          if (text !== wanted) continue;
          const current = button.querySelector('svg');
          if (current === null || current.getAttribute('data-dssi-icon') !== null) continue;
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          const cls = current.getAttribute('class');
          if (cls !== null) icon.setAttribute('class', cls);
          icon.setAttribute('width', '16');
          icon.setAttribute('height', '16');
          icon.setAttribute('viewBox', '0 0 24 24');
          icon.setAttribute('fill', 'none');
          icon.setAttribute('stroke', 'currentColor');
          icon.setAttribute('stroke-width', '1.7');
          icon.setAttribute('stroke-linecap', 'round');
          icon.setAttribute('stroke-linejoin', 'round');
          icon.setAttribute('aria-hidden', 'true');
          icon.setAttribute('focusable', 'false');
          icon.setAttribute('data-dssi-icon', '1');
          for (const d of ['M12 3v10', 'M8 9l4 4 4-4', 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3']) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            icon.appendChild(path);
          }
          current.replaceWith(icon);
        }
      };
      const schedule = () => {
        if (timer !== 0) return;
        timer = setTimeout(paint, 50);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      schedule();
      return () => {
        if (timer !== 0) {
          clearTimeout(timer);
          timer = 0;
        }
        observer.disconnect();
      };
    }

    function apply(ctx) {
      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);
        return () => {
          if (styleEl.parentNode !== null) styleEl.parentNode.removeChild(styleEl);
        };
      }, 'dsh-share-import: styles');

      const locale = ctx.get('locale');
      let translate = t;
      if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(() => locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-share-import: dictionaries');
        translate = locale.bind(NS);
      }

      ctx.effect(() => installSettingsNavIcon(() => translate('panel')), 'dsh-share-import: settings nav icon');

      const slots = ctx.get('slots');
      if (slots === undefined) return;

      const refreshSessions = () => {
        try {
          const sessions = ctx.get('sessions');
          if (sessions !== undefined && typeof sessions.refresh === 'function') sessions.refresh();
        } catch (error) { /* the session appears on the next list pull */ }
      };
      const closePanel = () => {
        try {
          const layout = ctx.get('layout');
          if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null);
        } catch (error) { /* the conversation stays reachable from the sidebar */ }
      };

      let disposers = [];
      const disposeAll = () => {
        const current = disposers;
        disposers = [];
        for (const dispose of current) {
          try { dispose(); } catch (error) { /* already gone */ }
        }
      };
      /** Turn the sidebar entry off without leaving our own panel open behind it. */
      const onToggleNav = (visible) => {
        writeNavPref(visible);
        if (!visible) {
          try {
            // Our own page in the DOM means the removed entry was the open panel.
            if (document.querySelector('[data-testid="share-import-page"]') !== null) {
              const layout = ctx.get('layout');
              if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null);
            }
          } catch (error) { /* the panel closes on the next navigation */ }
        }
        mount();
      };

      function mount() {
        disposeAll();
        const navRows = readNavPref()
          ? [slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            locale: NS,
            label: () => translate('panel'),
          }, PanelIcon))]
          : [];
        disposers = [
          slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: 'dsh-share-import',
            order: 40,
            label: () => translate('panel'),
          }, (props) => React.createElement(App, Object.assign({}, props, {
            t: translate,
            refreshSessions,
            showNavToggle: true,
            onToggleNav,
          })))),
        ].concat(navRows, [
          slots.inject('main', () => slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ t: translate, onClose: closePanel, refreshSessions }),
          }, PanelPage)),
        ]);
      }

      ctx.effect(() => {
        mount();
        return disposeAll;
      }, 'dsh-share-import: slots');

      if (typeof ctx.on === 'function') ctx.on('locale/change', mount);
    }

    module.exports = {
      apply,
      inject: ['slots'],
      __messages: { zh: DICT_ZH, en: DICT_EN },
    };
    //#endregion
    return module.exports;
  },
});
