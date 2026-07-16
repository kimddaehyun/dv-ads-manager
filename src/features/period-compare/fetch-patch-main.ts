/**
 * MAIN-world fetch/XHR 패치 — 페이지의 stats 요청을 가로채 ISOLATED 콘텐츠
 * 스크립트로 전달한다. ads.naver.com 광고 대시보드 6개 매체 페이지의
 * "전후 비교" 팝오버가 페이지가 이미 호출하는 fetch를 학습해 직전 기간
 * 데이터를 같은 endpoint로 replay할 수 있게 하는 게 목적.
 *
 * 통신: `dvads:fetch-capture` CustomEvent 1방향 (MAIN → ISOLATED).
 * detail은 구조화 클론 호환 (string/number/plain object/array만).
 * 페이지의 어떤 fetch도 절대 차단·지연시키지 않는다 — 모든 작업은 then 체인 안에서만.
 *
 * 캡처 범위: 같은 origin(ads.naver.com)의 모든 비-정적 리소스 응답. fetch + XHR 둘 다.
 * 노이즈는 ISOLATED world 측 휴리스틱이 거른다.
 */
declare const __APP_VERSION__: string;

(() => {
  const w = window as unknown as { __dvadsFetchPatched?: boolean };
  if (w.__dvadsFetchPatched) return;
  w.__dvadsFetchPatched = true;

  function shouldCapture(url: string): boolean {
    try {
      const u = new URL(url, location.href);
      // ads.naver.com 페이지가 다른 naver.com 서브도메인(gw.searchad.naver.com 등)으로
      // API를 호출하는 케이스를 잡기 위해 도메인 조건을 .naver.com 전체로 확장.
      const host = u.hostname.toLowerCase();
      if (host !== "naver.com" && !host.endsWith(".naver.com")) return false;
      // 정적 리소스 제외
      if (/\.(png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|otf|css|js|mjs|map)(\?|$)/i.test(u.pathname))
        return false;
      // stats를 담은 endpoint만 캡처. GFA 등 광고관리자 페이지는 한 번에 수십 개의 noise
      // API(constants/authorities/billing/user/regulations/managed-customers 등)를 호출하는데,
      // 이를 전부 clone+JSON.parse+stringify+dispatch+walk하면 페이지 데이터 로딩이 느려진다.
      // F-PoP가 쓰는 6개 매체 데이터 소스는 모두 stats/search/reports 경로:
      //   SA `/apis/sa/api/stats`, dashboard `campaigns/search`·`reports/search`,
      //   GFA `stats/campaignStats`. URL 단계에서 이 셋만 통과시켜 noise를 배제.
      if (!/\/(stats|search|reports?)(\/|$)/i.test(u.pathname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  function extractUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
  }

  function headersFromInit(
    init: RequestInit | undefined,
    fallbackInput: RequestInfo | URL,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    const collect = (h: Headers | HeadersInit | undefined) => {
      if (!h) return;
      const hh = h instanceof Headers ? h : new Headers(h);
      hh.forEach((v, k) => {
        out[k] = v;
      });
    };
    if (init?.headers) collect(init.headers as HeadersInit);
    if (fallbackInput instanceof Request) collect(fallbackInput.headers);
    return out;
  }

  function dispatch(detail: Record<string, unknown>): void {
    // 구조화 클론 안전: response가 Apollo/React reactive 객체일 수 있어 그대로 detail에
    // 넣으면 dispatch가 throw됨. JSON 문자열로 직렬화 후 ISOLATED에서 parse한다.
    let safeDetail: Record<string, unknown> = detail;
    if (detail.response != null && typeof detail.response === "object") {
      try {
        safeDetail = { ...detail, response: JSON.stringify(detail.response) };
      } catch {
        safeDetail = { ...detail, response: null };
      }
    }
    try {
      window.dispatchEvent(new CustomEvent("dvads:fetch-capture", { detail: safeDetail }));
    } catch (err) {
      try {
        console.warn("[dv-ads/MAIN] dispatch failed", detail.url, err);
      } catch {
        /* */
      }
    }
  }

  // 디버그 — 모든 fetch/XHR 호출이 우리 wrap을 통과하는지 진단. 평소엔 false (요청마다 console.log는
  // 비용이 크고 GFA처럼 요청 많은 페이지를 느리게 함). 가로채기 진단 필요할 때만 일시 true.
  const DEBUG_TRACE = false;

  // ─── fetch wrap ───
  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    if (DEBUG_TRACE) {
      try {
        const u = extractUrl(input);
        if (!/\.(png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|otf|css|js|mjs|map)(\?|$)/i.test(u)) {
          console.log(
            "[dv-ads/MAIN] fetch ->",
            (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
            u,
          );
        }
      } catch {
        /* */
      }
    }
    const promise = originalFetch.call(this, input as RequestInfo, init);
    promise
      .then((resp) => {
        try {
          const url = extractUrl(input);
          if (!shouldCapture(url)) return;
          const method = (
            init?.method ?? (input instanceof Request ? input.method : "GET")
          ).toUpperCase();
          const headers = headersFromInit(init, input);
          const body = typeof init?.body === "string" ? init.body : null;
          const status = resp.status;
          const cloned = resp.clone();
          cloned
            .text()
            .then((text) => {
              let response: unknown = null;
              if (text) {
                try {
                  response = JSON.parse(text);
                } catch {
                  response = null;
                }
              }
              dispatch({
                url,
                method,
                headers,
                body,
                status,
                response,
                ts: Date.now(),
                via: "fetch",
              });
            })
            .catch(() => {});
        } catch {
          /* swallow — never break page */
        }
      })
      .catch(() => {});
    return promise;
  };

  // ─── XHR wrap ───
  type XhrInternal = XMLHttpRequest & {
    __dvadsUrl?: string;
    __dvadsMethod?: string;
    __dvadsHeaders?: Record<string, string>;
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (
    this: XhrInternal,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__dvadsUrl = typeof url === "string" ? url : url.href;
    this.__dvadsMethod = method.toUpperCase();
    this.__dvadsHeaders = {};
    // @ts-expect-error — passthrough
    return xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (
    this: XhrInternal,
    name: string,
    value: string,
  ) {
    if (this.__dvadsHeaders) this.__dvadsHeaders[name] = value;
    return xhrSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (
    this: XhrInternal,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const url = this.__dvadsUrl;
    if (DEBUG_TRACE && url && !/\.(png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|otf|css|js|mjs|map)(\?|$)/i.test(url)) {
      console.log("[dv-ads/MAIN] xhr ->", this.__dvadsMethod ?? "GET", url);
    }
    if (url && shouldCapture(url)) {
      const bodyStr = typeof body === "string" ? body : null;
      let dispatched = false;
      const tryDispatch = (trigger: string) => {
        if (dispatched) return;
        if (this.readyState !== 4) return;
        dispatched = true;
        try {
          let response: unknown = null;
          // responseType이 'json'이면 this.response가 라이브 객체 — JSON.parse(JSON.stringify())로 plain화.
          // text/빈 responseType은 responseText 사용. 그 외 (blob/arraybuffer)는 null.
          try {
            if (this.responseType === "" || this.responseType === "text") {
              const t = this.responseText;
              if (t) response = JSON.parse(t);
            } else if (this.responseType === "json") {
              const raw = this.response;
              if (raw != null) response = JSON.parse(JSON.stringify(raw));
            }
          } catch {
            response = null;
          }
          if (DEBUG_TRACE) {
            console.log(
              "[dv-ads/MAIN] xhr done",
              trigger,
              this.status,
              url,
              "respType=",
              this.responseType,
              "hasResp=",
              response != null,
            );
          }
          dispatch({
            url,
            method: this.__dvadsMethod ?? "GET",
            headers: this.__dvadsHeaders ?? {},
            body: bodyStr,
            status: this.status,
            response,
            ts: Date.now(),
            via: "xhr",
          });
        } catch (err) {
          try {
            console.warn("[dv-ads/MAIN] xhr capture err", url, err);
          } catch {
            /* */
          }
        }
      };
      // readystatechange만 listen하면 sentry/페이지 wrap이 가로채는 케이스가 있어 못 받는다.
      // load/error/abort/loadend 4가지 path 모두 listen — 멱등성은 dispatched flag로 보장.
      try {
        this.addEventListener("readystatechange", () => tryDispatch("rsc"));
        this.addEventListener("load", () => tryDispatch("load"));
        this.addEventListener("loadend", () => tryDispatch("loadend"));
        this.addEventListener("error", () => tryDispatch("error"));
        this.addEventListener("abort", () => tryDispatch("abort"));
      } catch {
        /* addEventListener 자체가 fail이면 포기 */
      }
    }
    return xhrSend.call(this, body);
  };

  try {
    console.warn(
      `[dv-ads/MAIN] patch installed · fetch+xhr wrapped · v${__APP_VERSION__} · trace=${DEBUG_TRACE}`,
    );
  } catch {
    /* */
  }
})();

export {};
