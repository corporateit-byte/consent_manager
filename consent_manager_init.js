'use strict';

/**
 * Shared consent-manager orchestrator, served via jsDelivr and reused across
 * every site. Each site only needs to define window.STCM_CONFIG before this
 * script runs - no other per-site logic should live in the page <head>.
 *
 * Expected window.STCM_CONFIG shape (all keys optional except where noted):
 * {
 *   clarity: { id: "xxxxxxxxxx" },
 *   gtm: { id: "GTM-XXXXXXX" },
 *   googleAnalytics: { id: "G-XXXXXXXXXX" },
 *   googleAds: {
 *     id: "AW-XXXXXXXXX",
 *     conversionEvents: [{ name: "ads_conversion_x", params: {} }]
 *   },
 *   cookiePolicyUrl: "https://site.com/cookie-policy", // optional - omit to hide the link
 *   lang: { default: "en_US" },              // used if frontend_lang cookie is missing/unrecognized
 *   restrictedCountries: ["AT", "BE", ...],   // optional override of the EEA/UK/CH default list
 *   icon: { position: "bottomLeft" },
 *   prompt: { position: "bottomCenter" },
 *   onEssentialAccept: function () {}         // optional hook for site-specific essential-cookie logic
 * }
 */
(function () {
  var config = window.STCM_CONFIG || {};

  // ------------------------------------------------------------------
  // Countries where cookies/tracking require opt-in consent by default
  // (EU/EEA + UK + CH). Override per site via config.restrictedCountries.
  // ------------------------------------------------------------------
  var RESTRICTED_COUNTRIES = config.restrictedCountries || [
    "AT", "BE", "BG", "HR", "CY", "CZ", "DE", "DK", "EE",
    "ES", "FI", "FR", "GR", "HU", "IE", "IT", "LT", "LU",
    "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
    "IS", "LI", "NO", "CH", "GB"
  ];

  // ------------------------------------------------------------------
  // Google Consent Mode v2 + GTM/gtag bootstrap.
  // Runs immediately (this script must NOT be loaded with defer/async) so
  // the "denied by default in restricted regions" signal reaches Google
  // before GTM/gtag.js parse the dataLayer queue.
  // ------------------------------------------------------------------
  function bootstrapGoogle() {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

    // Baseline: granted everywhere...
    window.gtag('consent', 'default', {
      ad_storage: 'granted',
      analytics_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted'
    });

    // ...except in the restricted regions, where Google's own geolocation
    // applies this denied default instead, until the consent manager below
    // sends an explicit update.
    window.gtag('consent', 'default', {
      ad_storage: 'denied',
      analytics_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      region: RESTRICTED_COUNTRIES,
      wait_for_update: 500
    });

    if (config.gtm && config.gtm.id) {
      (function (w, d, s, l, i) {
        w[l] = w[l] || [];
        w[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
        var f = d.getElementsByTagName(s)[0],
          j = d.createElement(s), dl = l != 'dataLayer' ? '&l=' + l : '';
        j.async = true;
        j.src = 'https://www.googletagmanager.com/gtm.js?id=' + i + dl;
        f.parentNode.insertBefore(j, f);
      })(window, document, 'script', 'dataLayer', config.gtm.id);
    }

    // GA4 and Google Ads both load through the same gtag.js script - only
    // inject it once, then config() each id that's present.
    var gtagIds = [];
    if (config.googleAnalytics && config.googleAnalytics.id) gtagIds.push(config.googleAnalytics.id);
    if (config.googleAds && config.googleAds.id) gtagIds.push(config.googleAds.id);

    if (gtagIds.length) {
      var gtagScript = document.createElement('script');
      gtagScript.async = true;
      gtagScript.src = 'https://www.googletagmanager.com/gtag/js?id=' + gtagIds[0];
      document.head.appendChild(gtagScript);

      window.gtag('js', new Date());
      gtagIds.forEach(function (id) { window.gtag('config', id); });

      if (config.googleAds) {
        (config.googleAds.conversionEvents || []).forEach(function (evt) {
          window.gtag('event', evt.name, evt.params || {});
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Microsoft Clarity - loaded/stopped based on the "analytics" consent type.
  // No-op if the site didn't configure a Clarity id.
  // ------------------------------------------------------------------
  function loadClarity() {
    if (!config.clarity || !config.clarity.id || window.__clarityLoaded) return;
    window.__clarityLoaded = true;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", config.clarity.id);
  }

  function stopClarity() {
    if (!config.clarity || !config.clarity.id) return;
    window.__clarityLoaded = false;
    window.clarity = function () {};
    document.cookie = "_clck=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    document.cookie = "_clsk=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    localStorage.removeItem('_clck');
    sessionStorage.removeItem('_clsk');
  }

  // ------------------------------------------------------------------
  // Country detection via Cloudflare's edge - works from any origin, no
  // key or server changes needed even when the site isn't on Cloudflare.
  // Resolves null if it can't be determined; callers must treat that as
  // "restricted" so cookies fail closed rather than open.
  // ------------------------------------------------------------------
  var COUNTRY_CACHE_KEY = "stcm_country";
  var COUNTRY_DETECT_TIMEOUT_MS = 2500;

  function detectCountry() {
    return new Promise(function (resolve) {
      var cached = sessionStorage.getItem(COUNTRY_CACHE_KEY);
      if (cached) {
        resolve(cached);
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        settled = true;
        resolve(null);
      }, COUNTRY_DETECT_TIMEOUT_MS);

      fetch("https://www.cloudflare.com/cdn-cgi/trace")
        .then(function (res) { return res.text(); })
        .then(function (text) {
          if (settled) return;
          clearTimeout(timer);
          var match = text.match(/loc=([A-Z]{2})/);
          var country = match ? match[1] : null;
          if (country) sessionStorage.setItem(COUNTRY_CACHE_KEY, country);
          resolve(country);
        })
        .catch(function () {
          if (settled) return;
          clearTimeout(timer);
          resolve(null);
        });
    });
  }

  // ------------------------------------------------------------------
  // Language - read from the "frontend_lang" cookie Odoo already sets
  // (e.g. en_US, es_MX, ja_JP), falling back to config.lang.default.
  // ------------------------------------------------------------------
  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  var TRANSLATIONS = {
    en_US: {
      consentTypes: {
        essential: {
          label: "Essential",
          description: "<p>These cookies are necessary for the website to function properly and cannot be switched off. They help with things like logging in and setting your privacy preferences.</p>"
        },
        analytics: {
          label: "Analytics",
          description: "<p>These cookies help us improve the site by tracking which pages are most popular and how visitors move around the site.</p>"
        },
        marketing: {
          label: "Marketing",
          description: "<p>These cookies are used by us and our advertising partners to show you relevant ads on this site and elsewhere, and to measure how those campaigns perform.</p>"
        }
      },
      text: {
        prompt: {
          description: "<p>We use cookies on our site to enhance your user experience, provide personalized content, and analyze our traffic.</p>",
          cookiePolicyLinkText: "Cookie policy",
          acceptAllButtonText: "Accept all",
          acceptAllButtonAccessibleLabel: "Accept all cookies",
          rejectNonEssentialButtonText: "Reject non-essential",
          rejectNonEssentialButtonAccessibleLabel: "Reject all non-essential cookies",
          preferencesButtonText: "Preferences",
          preferencesButtonAccessibleLabel: "Toggle preferences"
        },
        preferences: {
          title: "Customize your cookie preferences",
          description: "<p>We respect your right to privacy. You can choose not to allow some types of cookies. Your cookie preferences will apply across our website.</p>",
          saveButtonText: "Save and close",
          saveButtonAccessibleLabel: "Save your cookie preferences",
          creditLinkText: "Get this banner for free",
          creditLinkAccessibleLabel: "Get this banner for free"
        },
        icon: {
          title: "Manage your consent preferences for this site"
        }
      }
    },
    es_MX: {
      consentTypes: {
        essential: {
          label: "Esenciales",
          description: "<p>Estas cookies son necesarias para que el sitio web funcione correctamente y no se pueden desactivar. Ayudan con funciones como iniciar sesión y guardar tus preferencias de privacidad.</p>"
        },
        analytics: {
          label: "Analíticas",
          description: "<p>Estas cookies nos ayudan a mejorar el sitio al identificar las páginas más populares y cómo se desplazan los visitantes por el sitio.</p>"
        },
        marketing: {
          label: "Marketing",
          description: "<p>Estas cookies son utilizadas por nosotros y nuestros socios publicitarios para mostrarte anuncios relevantes en este sitio y en otros, y para medir el rendimiento de esas campañas.</p>"
        }
      },
      text: {
        prompt: {
          description: "<p>Utilizamos cookies en nuestro sitio para mejorar tu experiencia de usuario, ofrecer contenido personalizado y analizar nuestro tráfico.</p>",
          cookiePolicyLinkText: "Política de cookies",
          acceptAllButtonText: "Aceptar todas",
          acceptAllButtonAccessibleLabel: "Aceptar todas las cookies",
          rejectNonEssentialButtonText: "Rechazar no esenciales",
          rejectNonEssentialButtonAccessibleLabel: "Rechazar todas las cookies no esenciales",
          preferencesButtonText: "Preferencias",
          preferencesButtonAccessibleLabel: "Alternar preferencias"
        },
        preferences: {
          title: "Personaliza tus preferencias de cookies",
          description: "<p>Respetamos tu derecho a la privacidad. Puedes optar por no permitir algunos tipos de cookies. Tus preferencias se aplicarán en todo nuestro sitio web.</p>",
          saveButtonText: "Guardar y cerrar",
          saveButtonAccessibleLabel: "Guardar tus preferencias de cookies",
          creditLinkText: "Obtén este banner gratis",
          creditLinkAccessibleLabel: "Obtén este banner gratis"
        },
        icon: {
          title: "Administra tus preferencias de consentimiento para este sitio"
        }
      }
    },
    ja_JP: {
      consentTypes: {
        essential: {
          label: "必須",
          description: "<p>これらのクッキーは、ウェブサイトが正常に機能するために必要であり、無効にすることはできません。ログインやプライバシー設定の保存などに役立ちます。</p>"
        },
        analytics: {
          label: "アナリティクス",
          description: "<p>これらのクッキーは、人気のあるページや訪問者のサイト内での行動を把握することで、サイトの改善に役立ちます。</p>"
        },
        marketing: {
          label: "マーケティング",
          description: "<p>これらのクッキーは、当社および広告パートナーが本サイトや他のサイトで関連性の高い広告を表示し、そのキャンペーンの効果を測定するために使用されます。</p>"
        }
      },
      text: {
        prompt: {
          description: "<p>当サイトでは、ユーザー体験の向上、パーソナライズされたコンテンツの提供、トラフィックの分析のためにクッキーを使用しています。</p>",
          cookiePolicyLinkText: "クッキーポリシー",
          acceptAllButtonText: "すべて同意する",
          acceptAllButtonAccessibleLabel: "すべてのクッキーに同意する",
          rejectNonEssentialButtonText: "必須以外を拒否",
          rejectNonEssentialButtonAccessibleLabel: "必須ではないすべてのクッキーを拒否する",
          preferencesButtonText: "設定",
          preferencesButtonAccessibleLabel: "設定を切り替える"
        },
        preferences: {
          title: "クッキーの設定をカスタマイズ",
          description: "<p>私たちはあなたのプライバシーの権利を尊重します。一部の種類のクッキーを許可しないことを選択できます。設定はサイト全体に適用されます。</p>",
          saveButtonText: "保存して閉じる",
          saveButtonAccessibleLabel: "クッキー設定を保存する",
          creditLinkText: "このバナーを無料で入手",
          creditLinkAccessibleLabel: "このバナーを無料で入手"
        },
        icon: {
          title: "このサイトの同意設定を管理する"
        }
      }
    }
  };

  function resolveLang() {
    var fallback = (config.lang && config.lang.default) || 'en_US';
    if (!TRANSLATIONS[fallback]) fallback = 'en_US';

    var cookieLang = getCookie('frontend_lang');
    return (cookieLang && TRANSLATIONS[cookieLang]) ? cookieLang : fallback;
  }

  // ------------------------------------------------------------------
  // Consent manager
  // ------------------------------------------------------------------
  var consentBehavior = {
    essential: {
      required: true,
      onAccept: function () {
        if (typeof config.onEssentialAccept === 'function') config.onEssentialAccept();
      }
    },
    analytics: {
      required: false,
      gtag: "analytics_storage",
      onAccept: loadClarity,
      onReject: stopClarity
    },
    marketing: {
      required: false,
      gtag: ["ad_storage", "ad_user_data", "ad_personalization"]
    }
  };

  // Appends the "Cookie policy" link to the prompt description, using the
  // site-configured URL. No-op (link omitted) if the site didn't set one.
  function buildPromptText(promptText) {
    if (!config.cookiePolicyUrl) return promptText;

    var link = ' <a href="' + config.cookiePolicyUrl + '" target="_blank" rel="noopener">' +
      promptText.cookiePolicyLinkText + '</a>';

    return Object.assign({}, promptText, {
      description: promptText.description.replace(/<\/p>\s*$/, link + '</p>')
    });
  }

  function startConsentManager(isRestrictedCountry) {
    var selected = TRANSLATIONS[resolveLang()];

    var consentTypes = Object.keys(consentBehavior).map(function (id) {
      var behavior = Object.assign({}, consentBehavior[id]);
      if (!behavior.required) {
        behavior.defaultValue = !isRestrictedCountry;
      }
      return Object.assign({ id: id }, behavior, selected.consentTypes[id]);
    });

    var text = Object.assign({}, selected.text, {
      prompt: buildPromptText(selected.text.prompt)
    });

    window.silktideConsentManager.init({
      backdrop: { show: false },
      icon: { position: (config.icon && config.icon.position) || "bottomLeft" },
      prompt: { position: (config.prompt && config.prompt.position) || "bottomCenter" },
      // Pre-apply each type's defaultValue (enabled unless the visitor is in
      // a restricted country) so it's active from page load, while the
      // banner is still always shown for the user to confirm or reject.
      preselectDefaults: true,
      consentTypes: consentTypes,
      text: text
    });
  }

  function initConsentManager() {
    // Only worth detecting the country before the visitor's first choice -
    // once a choice exists, it's already respected regardless of location.
    var hasExistingConsent = !!localStorage.getItem('stcm.hasConsented');
    if (hasExistingConsent) {
      startConsentManager(false);
    } else {
      detectCountry().then(function (country) {
        var isRestricted = !country || RESTRICTED_COUNTRIES.indexOf(country) !== -1;
        startConsentManager(isRestricted);
      });
    }
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  bootstrapGoogle();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsentManager, { once: true });
  } else {
    initConsentManager();
  }
})();
