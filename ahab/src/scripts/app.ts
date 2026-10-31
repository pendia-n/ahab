import {
  serviceFor,
  compatible,
  taskById,
  type TaskType,
  type Service,
  type Resolution,
  type OfferInput,
  type Quote,
} from "../lib/offers";
export {};
type Asset = {
  id: string;
  kind: string;
  name?: string;
  mime?: string;
  duration?: number;
  createdAt: number | string;
  expiresAt?: number | string;
  url?: string;
};
type Allowance = {
  id: string;
  packageId: string;
  name?: string;
  videosRemaining: number;
  portraitsRemaining: number;
  maxDuration: number;
  service: Service;
  resolution: Resolution;
  generatedCapacity: number;
  legacy: boolean;
};
type Job = {
  id: string;
  kind?: string;
  mode?: string;
  status: string;
  duration?: number;
  createdAt: number | string;
  assetId?: string;
  error?: string;
};
type Library = {
  assets: Asset[];
  prompts: { id: string; text: string; createdAt: number | string }[];
  jobs: Job[];
};
type Config = {
  voices: { id: string; name: string }[];
  generationEnabled: boolean;
  checkoutEnabled: boolean;
  usdcEnabled?: boolean;
  maxPresenterDuration?: number;
  reason?: string;
  checkoutReason?: string;
  expressEnabled?: boolean;
};
type QueryRoot = {
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<unknown>;
};
const $ = <T = HTMLElement>(selector: string, root: QueryRoot = document) =>
  root.querySelector(selector) as T | null;
const $$ = <T = HTMLElement>(selector: string, root: QueryRoot = document) =>
  Array.from(root.querySelectorAll(selector)) as T[];
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const safeUrl = (value: unknown) => {
  try {
    const url = new URL(String(value), location.origin);
    return url.origin === location.origin ? url.pathname + url.search : "#";
  } catch {
    return "#";
  }
};
const date = (value: unknown) => {
  const n = typeof value === "number" && value < 1e12 ? value * 1000 : value;
  const d = new Date(n as string | number);
  return Number.isNaN(d.valueOf())
    ? ""
    : d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
};
const assetUrl = (asset: Asset) =>
  safeUrl(asset.url || `/api/media/${encodeURIComponent(asset.id)}`);
const formData = (form: HTMLFormElement) =>
  Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) {
  const node = $(".toast");
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 4500);
}
function status(form: QueryRoot, message: string, error = false) {
  const node = $(".form-status", form);
  if (node) {
    node.textContent = message;
    node.classList.toggle("error", error);
    node.classList.toggle("success", !error);
  }
}
function busy(form: QueryRoot, loading: boolean) {
  $$<HTMLButtonElement>("button[type=submit]", form).forEach((button) => {
    button.disabled = loading;
    button.setAttribute("aria-busy", String(loading));
  });
}
async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET")
    headers.set("X-Ahab-Request", "1");
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload: any = await response.json().catch(() => ({
    error: "The server returned an unreadable response. Try again.",
  }));
  if (!response.ok)
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "This request could not be completed. Try again.",
    );
  return payload as T;
}
const post = <T = any>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
const showError = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "This request could not be completed. Try again.";

// Recheck server auth when history or another tab may have changed the session.
// Cookies remain HttpOnly; only the signed-in boolean is compared in the browser.
let checkingSession = false;
async function refreshSessionNavigation() {
  const rendered = document.body.dataset.sessionState;
  if (
    checkingSession ||
    !navigator.onLine ||
    document.visibilityState !== "visible" ||
    !rendered ||
    rendered === "offline"
  )
    return;
  checkingSession = true;
  try {
    const { user } = await api<{ user: unknown }>("/api/auth/me");
    if ((rendered === "authenticated") !== !!user) location.reload();
  } catch {
  } finally {
    checkingSession = false;
  }
}
window.addEventListener("pageshow", (event) => {
  if (event.persisted && navigator.onLine) location.reload();
});
window.addEventListener("focus", () => void refreshSessionNavigation());
document.addEventListener(
  "visibilitychange",
  () => void refreshSessionNavigation(),
);
function nextPath() {
  const requested = new URLSearchParams(location.search).get("next");
  try {
    if (!requested?.startsWith("/") || requested.includes("\\"))
      return "/studio";
    const parsed = new URL(requested, location.origin);
    return parsed.origin === location.origin
      ? parsed.pathname + parsed.search
      : "/studio";
  } catch {
    return "/studio";
  }
}

// Session credentials stay in the HTTP-only cookie, never in browser storage.
$$<HTMLFormElement>("form[data-auth]").forEach((form) =>
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    busy(form, true);
    status(form, "");
    try {
      const body = formData(form);
      if (!body.passcode) delete body.passcode;
      await post(`/api/auth/${form.dataset.auth}`, body);
      location.assign(nextPath());
    } catch (error) {
      status(form, showError(error), true);
      busy(form, false);
    }
  }),
);
$$<HTMLButtonElement>("[data-password-toggle]").forEach((button) =>
  button.addEventListener("click", () => {
    const input = $<HTMLInputElement>("#" + button.dataset.passwordToggle);
    if (input) {
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      button.textContent = visible ? "Hide" : "Show";
      button.setAttribute(
        "aria-label",
        visible ? "Hide password" : "Show password",
      );
    }
  }),
);
let usernameTimer: ReturnType<typeof setTimeout>;
const username = $<HTMLInputElement>("[data-auth=signup] input[name=username]");
username?.addEventListener("input", () => {
  clearTimeout(usernameTimer);
  const value = username.value;
  const node = $("[data-username-status]");
  if (!node) return;
  if (!/^[a-z0-9_]{3,24}$/i.test(value)) {
    node.textContent = "Use 3–24 letters, numbers or underscores.";
    node.classList.remove("error");
    return;
  }
  node.textContent = "Checking availability…";
  usernameTimer = setTimeout(async () => {
    try {
      const result = await api(
        `/api/auth/username?username=${encodeURIComponent(value)}`,
      );
      if (username.value !== value) return;
      node.textContent = result.available
        ? "This username is available."
        : "That username is already in use.";
      node.classList.toggle("error", !result.available);
    } catch {
      node.textContent =
        "Availability will be checked when you create your account.";
    }
  }, 350);
});
let recoveryTicket = "";
$<HTMLFormElement>("#recovery-verify")?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    busy(form, true);
    status(form, "");
    try {
      const result = await post("/api/auth/recovery/verify", formData(form));
      recoveryTicket = result.ticket;
      form.hidden = true;
      const reset = $<HTMLFormElement>("#recovery-reset")!;
      reset.hidden = false;
      $<HTMLInputElement>("input", reset)?.focus();
    } catch (error) {
      status(form, showError(error), true);
    } finally {
      busy(form, false);
    }
  },
);
$<HTMLFormElement>("#recovery-reset")?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    busy(form, true);
    try {
      await post("/api/auth/recovery/reset", {
        ticket: recoveryTicket,
        password: formData(form).password,
      });
      status(form, "Your password is saved. Taking you to sign in…");
      setTimeout(() => location.assign("/signin"), 900);
    } catch (error) {
      status(form, showError(error), true);
      busy(form, false);
    }
  },
);
$$<HTMLFormElement>("[data-security]").forEach((form) =>
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    busy(form, true);
    status(form, "");
    try {
      const body: Record<string, unknown> = formData(form);
      if (form.dataset.security === "remove") body.removePasscode = true;
      const result = await post("/api/auth/security", body);
      form.reset();
      if (result.signedOut) {
        status(form, "Your password is saved. Sign in again to continue.");
        setTimeout(() => location.assign("/signin"), 900);
        return;
      }
      status(
        form,
        form.dataset.security === "password"
          ? "Your password has been updated."
          : "Recovery settings saved.",
      );
      toast("Security settings saved.");
      if (form.dataset.security !== "password")
        setTimeout(() => location.reload(), 1200);
    } catch (error) {
      status(form, showError(error), true);
    } finally {
      busy(form, false);
    }
  }),
);
$$<HTMLButtonElement>("[data-logout]").forEach((button) =>
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await post("/api/auth/logout", {});
      location.assign("/signin");
    } catch (error) {
      toast(showError(error));
      button.disabled = false;
    }
  }),
);

// Public assets only: authenticated pages, API responses and private media bypass the service worker cache.
if ("serviceWorker" in navigator)
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {}),
  );
let installPrompt: any;
window.addEventListener("beforeinstallprompt", (event: Event) => {
  event.preventDefault();
  installPrompt = event;
  $$<HTMLButtonElement>("[data-install]").forEach(
    (button) => (button.hidden = false),
  );
});
$$<HTMLButtonElement>("[data-install]").forEach((button) =>
  button.addEventListener("click", async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    installPrompt = null;
    $$<HTMLButtonElement>("[data-install]").forEach(
      (item) => (item.hidden = true),
    );
  }),
);
function onlineStatus() {
  const banner = $(".offline-banner");
  if (banner) banner.hidden = navigator.onLine;
}
window.addEventListener("online", onlineStatus);
window.addEventListener("offline", onlineStatus);
onlineStatus();

const empty = (title: string, message: string, action = true) =>
  `<div class="empty-state"><div class="empty-icon"><svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 5h16v15H4zM8 2h8M8 10h8M8 14h5"/></svg></div><h2>${escape(title)}</h2><p>${escape(message)}</p>${action ? '<a class="button secondary small" href="/studio">Make your next take →</a>' : ""}</div>`;
const statusLabel = (value: string) =>
  ({
    queued: "Queued",
    submitting: "Sending to the studio",
    pending: "Waiting to start",
    in_progress: "In the making",
    uncertain: "Checking generation status",
    completed: "Completed",
    failed: "Failed",
  })[value] || value;
const jobsMarkup = (jobs: Job[]) =>
  jobs
    .map(
      (job) =>
        `<div class="job-item"><div><strong>${job.kind === "portrait" ? "AI portrait" : job.mode === "video_reference" ? "Short scene" : "Presenter video"}${job.duration ? ` · ${job.duration}s` : ""}</strong><small>${date(job.createdAt)}${job.error ? ` · ${escape(job.error)}` : ""}</small></div><span class="pill ${job.status === "completed" ? "green" : job.status === "failed" ? "amber" : ""}">${escape(statusLabel(job.status))}</span></div>`,
    )
    .join("");

async function initializeLibrary() {
  const target = $("#library-content");
  if (!target) return;
  let data: Library;
  let filter = "output";
  const render = () => {
    if (!data) return;
    const stats = $("#library-stats");
    if (stats)
      stats.innerHTML = [
        { kind: "image", name: "Saved images", limit: 40 },
        { kind: "audio", name: "Saved audio", limit: 20 },
        { kind: "video", name: "Video references", limit: 10 },
        { kind: "output", name: "Finished videos", limit: 23 },
      ]
        .map(
          (item) =>
            `<div class="stat-card"><strong>${data.assets.filter((asset) => asset.kind === item.kind).length}<span> / ${item.limit}</span></strong><span>${item.name}</span></div>`,
        )
        .join("");
    $$("[data-filter]").forEach((button) =>
      button.classList.toggle(
        "active",
        (button as HTMLElement).dataset.filter === filter,
      ),
    );
    if (filter === "jobs") {
      target.innerHTML = data.jobs?.length
        ? `<div class="job-list">${jobsMarkup(data.jobs)}</div>`
        : empty(
            "Your first take starts here.",
            "Generation progress and completed takes will appear here.",
          );
      return;
    }
    if (filter === "prompts") {
      target.innerHTML = data.prompts?.length
        ? `<div class="prompt-history">${data.prompts.map((prompt) => `<article class="prompt-card"><p>${escape(prompt.text)}</p><footer><span>${date(prompt.createdAt)}</span><span><button data-reuse-prompt="${escape(prompt.id)}">Use in studio</button><button data-delete-prompt="${escape(prompt.id)}">Delete</button></span></footer></article>`).join("")}</div>`
        : empty(
            "Keep a good line close.",
            "Save a creative direction in the studio to reuse it later.",
          );
      return;
    }
    const assets = data.assets.filter((asset) => asset.kind === filter);
    if (!assets.length) {
      const messages: Record<string, [string, string]> = {
        output: [
          "A space for your finished takes.",
          "Your completed videos will appear here. Start with a face and a few words.",
        ],
        image: [
          "A face for your next idea.",
          "Upload an image or create an AI portrait in the studio.",
        ],
        audio: [
          "A little room for your voice.",
          "Upload narration in the studio to give a presenter your own voice.",
        ],
        video: [
          "A moment to build on.",
          "Upload a short video reference in the studio to guide a scene.",
        ],
      };
      target.innerHTML = empty(...(messages[filter] || messages.output));
      return;
    }
    target.innerHTML = `<div class="asset-grid">${assets.map((asset) => `<article class="asset-card"><div class="asset-thumb">${asset.kind === "image" ? `<img src="${assetUrl(asset)}" alt="${escape(asset.name || "Saved reference image")}" loading="lazy"/>` : asset.kind === "audio" ? `<audio controls preload="none" src="${assetUrl(asset)}" aria-label="${escape(asset.name || "Saved narration")}"></audio>` : `<video controls playsinline preload="metadata" src="${assetUrl(asset)}" aria-label="${escape(asset.name || "Saved video")}"></video>`}</div><div class="asset-card-body"><h3 title="${escape(asset.name || "Your saved take")}">${escape(asset.name || "Your saved take")}</h3><p>${date(asset.createdAt)}${asset.duration ? ` · ${Math.round(asset.duration)}s` : ""}</p>${asset.expiresAt ? `<p>Available until ${date(asset.expiresAt)}</p>` : ""}<div class="asset-actions"><a href="${assetUrl(asset)}?download=1" download>Download</a>${asset.kind === "image" ? `<a href="/studio?image=${encodeURIComponent(asset.id)}">Use image</a>` : ""}<button data-delete-asset="${escape(asset.id)}">Delete</button></div></div></article>`).join("")}</div>`;
  };
  try {
    data = await api<Library>("/api/library");
    data.assets ??= [];
    data.prompts ??= [];
    data.jobs ??= [];
    const limits: { kind: string; name: string; limit: number }[] = [
      { kind: "image", name: "Saved images", limit: 40 },
      { kind: "audio", name: "Saved audio", limit: 20 },
      { kind: "video", name: "Video references", limit: 10 },
      { kind: "output", name: "Finished videos", limit: 23 },
    ];
    const stats = $("#library-stats");
    if (stats)
      stats.innerHTML = limits
        .map(
          (item) =>
            `<div class="stat-card"><strong>${data.assets.filter((asset) => asset.kind === item.kind).length}<span> / ${item.limit}</span></strong><span>${item.name}</span></div>`,
        )
        .join("");
    render();
  } catch (error) {
    target.innerHTML = empty(
      "Your library could not load.",
      showError(error),
      false,
    );
  }
  $$<HTMLButtonElement>("[data-filter]").forEach((button) =>
    button.addEventListener("click", () => {
      filter = button.dataset.filter!;
      render();
    }),
  );
  target.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-delete-asset],[data-delete-prompt],[data-reuse-prompt]",
    );
    if (!button) return;
    if (button.dataset.reusePrompt) {
      const prompt = data.prompts.find(
        (item) => item.id === button.dataset.reusePrompt,
      );
      if (prompt) {
        sessionStorage.setItem("ahab-draft-prompt", prompt.text);
        location.assign("/studio");
      }
      return;
    }
    const isAsset = !!button.dataset.deleteAsset;
    const id = isAsset
      ? button.dataset.deleteAsset
      : button.dataset.deletePrompt;
    if (!confirm("Delete this saved item? This cannot be undone.")) return;
    button.setAttribute("disabled", "");
    try {
      await api(
        `/api/${isAsset ? "media" : "prompts"}/${encodeURIComponent(id!)}`,
        { method: "DELETE" },
      );
      if (isAsset) data.assets = data.assets.filter((item) => item.id !== id);
      else data.prompts = data.prompts.filter((item) => item.id !== id);
      render();
      toast("Saved item deleted.");
    } catch (error) {
      toast(showError(error));
      button.removeAttribute("disabled");
    }
  });
}

const money = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
const option = (value: string, label: string) =>
  `<option value="${escape(value)}">${escape(label)}</option>`;
async function initializePurchases() {
  const target = $("#purchase-history");
  if (!target) return;
  try {
    const data = await api("/api/purchases");
    $("#checkout-availability")!.hidden = true;
    const root = $("#your-allowances")!;
    root.hidden = !data.allowances.length;
    $("#allowance-cards")!.innerHTML = data.allowances
      .map(
        (a: Allowance) =>
          `<article class="panel"><h3>${escape(a.name)}</h3><p>${a.videosRemaining} video allowance${a.videosRemaining === 1 ? "" : "s"} · ${a.portraitsRemaining} image preparation${a.portraitsRemaining === 1 ? "" : "s"}</p><small>${a.maxDuration ? `Up to ${a.maxDuration}s · ` : ""}${escape(a.resolution)} · no expiry</small><p><a class="text-link" href="/studio?allowance=${encodeURIComponent(a.id)}">Use when ready →</a></p></article>`,
      )
      .join("");
    target.innerHTML = data.purchases.length
      ? `<table><thead><tr><th>Purchase</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>${data.purchases.map((p: any) => `<tr><td>${escape(p.name)}</td><td>${date(p.createdAt)}</td><td>${money(p.amountCents)}</td><td><span class="pill">${escape(p.status)}</span></td></tr>`).join("")}</tbody></table>`
      : empty(
          "Your next idea has room here.",
          "Your verified purchases will appear here.",
          false,
        );
    const state = new URLSearchParams(location.search).get("checkout");
    if (state) {
      const n = $("#purchase-message")!;
      n.hidden = false;
      n.textContent =
        state === "success"
          ? "Checking payment. Allowances appear after payment is verified. Nothing starts generating until you choose."
          : "You can buy again whenever you are ready. An unpaid checkout does not use or block allowances.";
    }
  } catch (e) {
    target.textContent = showError(e);
  }
}
async function initializeOffers() {
  const form = $<HTMLFormElement>("#offer-form");
  if (!form) return;
  let config: Config = await api("/api/config").catch(() => ({
    voices: [],
    generationEnabled: false,
    checkoutEnabled: false,
  }));
  let cart: OfferInput[] = [];
  let quote: Quote | undefined;
  let quoteId = "";
  const duration = $<HTMLInputElement>("#offer-duration")!,
    resolution = $<HTMLSelectElement>("#offer-resolution")!,
    quantity = $<HTMLInputElement>("#offer-quantity")!,
    style = $<HTMLSelectElement>("#offer-style")!,
    delivery = $<HTMLSelectElement>("#offer-service")!;
  const task = () =>
    ($<HTMLInputElement>("input[name=taskType]:checked", form)?.value ||
      "presenter") as TaskType;
  const service = (): Service =>
    delivery.value === "express"
      ? "express"
      : serviceFor(task(), style.value === "scene");
  const note = $("#offer-status")!,
    review = $<HTMLButtonElement>("#review-purchase")!,
    pay = $<HTMLButtonElement>("#pay-purchase")!;
  try {
    const saved = sessionStorage.getItem("ahab-cart-v1");
    if (saved) cart = JSON.parse(saved).slice(0, 12);
  } catch {}
  const invalidate = () => {
    quote = undefined;
    quoteId = "";
    pay.hidden = true;
    note.textContent = "";
  };
  const render = () => {
    sessionStorage.setItem("ahab-cart-v1", JSON.stringify(cart));
    review.disabled = !cart.length;
    $("#offer-cart")!.innerHTML =
      cart
        .map(
          (i, index) =>
            `<div class="cart-line"><div><strong>${i.quantity} × ${i.service === "image" ? "Image preparation" : `${escape(taskById(i.taskType)?.name)} · ${i.duration}s · ${escape(i.resolution)}`}</strong><small>${i.service === "image" ? "One image operation per allowance" : `${i.service === "express" ? "Express" : "Standard"} · use separately, no expiry`}${quote ? ` · ${money(quote.items[index].unitAmountCents)} each${quote.items[index].minimumApplied ? " (minimum price)" : ""}` : ""}</small></div><button type="button" class="button ghost small" data-remove-cart="${index}">Remove</button></div>`,
        )
        .join("") +
      (quote
        ? `<p class="quote-total">${money(quote.amountCents)} <small>USD · one time</small></p>`
        : "");
  };
  const update = () => {
    const t = taskById(task())!;
    $("#offer-style-field")!.hidden = t.id !== "explainer";
    const s = serviceFor(t.id, style.value === "scene");
    duration.min = String(t.min);
    duration.max = String(t.id === "explainer" && s === "scene" ? 30 : t.max);
    duration.value = String(
      Math.max(
        t.min,
        Math.min(Number(duration.max), Number(duration.value) || t.min),
      ),
    );
    const old = delivery.value;
    delivery.innerHTML =
      option("standard", "Standard") +
      (config.expressEnabled && s === "scene"
        ? option("express", "Express")
        : "");
    if (old === "express" && config.expressEnabled && s === "scene")
      delivery.value = old;
    $("#offer-duration-note")!.textContent =
      "Each allowance makes one video. Use your allowances separately, whenever you are ready.";
  };
  form.addEventListener("change", update);
  duration.addEventListener("input", () => {
    if (duration.checkValidity()) update();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (cart.length >= 12) {
      note.textContent = "Buy up to 12 configurations in one purchase.";
      return;
    }
    invalidate();
    cart.push({
      taskType: task(),
      service: service(),
      duration: Number(duration.value),
      resolution: resolution.value as Resolution,
      quantity: Number(quantity.value),
    });
    render();
  });
  $("#add-image-credit")!.addEventListener("click", () => {
    if (cart.length >= 12) return;
    invalidate();
    cart.push({
      taskType: "presenter",
      service: "image",
      duration: 0,
      resolution: "1080p",
      quantity: 1,
    });
    render();
  });
  $("#offer-cart")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-remove-cart]",
    );
    if (!b) return;
    cart.splice(Number(b.dataset.removeCart), 1);
    invalidate();
    render();
  });
  review.addEventListener("click", async () => {
    review.disabled = true;
    note.textContent = "Checking your purchase…";
    try {
      const me = await api("/api/auth/me");
      const result = await post(
        me.user ? "/api/quotes" : "/api/quote-preview",
        { items: cart },
      );
      quote = result;
      quoteId = result.quoteId || "";
      render();
      pay.hidden = false;
      pay.textContent = me.user ? "Continue to payment" : "Sign in to purchase";
      pay.disabled = !!me.user && !config.checkoutEnabled;
      note.textContent = !me.user
        ? "Your total is shown above. Sign in to keep allowances in your account."
        : config.checkoutEnabled
          ? "Review the total above. Payment adds allowances; it does not start generation."
          : config.checkoutReason || "Purchases are currently unavailable.";
    } catch (e) {
      note.textContent = showError(e);
    } finally {
      review.disabled = !cart.length;
    }
  });
  pay.addEventListener("click", async () => {
    if (!quoteId) {
      location.assign("/signin?next=" + encodeURIComponent("/purchases"));
      return;
    }
    pay.disabled = true;
    try {
      const r = await post("/api/checkout", { quoteId });
      const url = new URL(r.url);
      if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com")
        throw new Error("The payment page could not be verified.");
      location.assign(url.href);
    } catch (e) {
      note.textContent = showError(e);
      pay.disabled = false;
    }
  });
  update();
  render();
}
async function preparePortraitAsset(id: string): Promise<Asset> {
  const image = new Image();
  image.src = "/api/media/" + encodeURIComponent(id);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 540;
  canvas.height = 960;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image preparation is unavailable.");
  const scale = Math.max(540 / image.naturalWidth, 960 / image.naturalHeight),
    w = image.naturalWidth * scale,
    h = image.naturalHeight * scale;
  context.drawImage(image, (540 - w) / 2, (960 - h) / 2, w, h);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (v) => (v ? resolve(v) : reject(new Error("Image preparation failed."))),
      "image/jpeg",
      0.93,
    ),
  );
  const form = new FormData();
  form.set("kind", "image");
  form.set(
    "file",
    new File([blob], "Prepared-reference-540x960.jpg", { type: "image/jpeg" }),
  );
  return (await api("/api/media", { method: "POST", body: form })).asset;
}
async function initializeStudio() {
  const form = $<HTMLFormElement>("#generate-form");
  if (!form) return;
  let library: Library = { assets: [], prompts: [], jobs: [] },
    allowances: Allowance[] = [],
    config: Config = {
      voices: [],
      generationEnabled: false,
      checkoutEnabled: false,
    };
  let images: string[] = [];
  let rawDirection = "";
  let shotPlan: string[] = [];
  let running = false;
  let key = crypto.randomUUID();
  let imageKey = crypto.randomUUID();
  let preparationKey = crypto.randomUUID();
  let polling: ReturnType<typeof setTimeout>;
  const task = $<HTMLSelectElement>("#task-type")!,
    style = $<HTMLSelectElement>("#studio-style")!,
    duration = $<HTMLInputElement>("#duration")!,
    resolution = $<HTMLSelectElement>("#resolution")!,
    delivery = $<HTMLSelectElement>("#studio-service")!,
    allowance = $<HTMLSelectElement>("#allowance")!,
    imageAllowance = $<HTMLSelectElement>("#image-allowance")!,
    script = $<HTMLTextAreaElement>("#script")!,
    direction = $<HTMLTextAreaElement>("#prompt")!,
    approved = $<HTMLInputElement>("#approved")!,
    generate = $<HTMLButtonElement>("#generate-button")!,
    audio = $<HTMLSelectElement>("#audio-reference")!,
    source = $<HTMLSelectElement>("#voice-source")!;
  const service = (): Service =>
    delivery.value === "express"
      ? "express"
      : serviceFor(task.value as TaskType, style.value === "scene");
  const selectedAllowance = () =>
    allowances.find((a) => a.id === allowance.value);
  const render = () => {
    const t = taskById(task.value)!;
    $("#task-description")!.textContent = t.description;
    $("#studio-style-field")!.hidden = t.id !== "explainer";
    const base = serviceFor(t.id, style.value === "scene");
    duration.min = String(t.min);
    duration.max = String(
      t.id === "explainer" && base === "scene" ? 30 : t.max,
    );
    duration.value = String(
      Math.max(
        t.min,
        Math.min(Number(duration.max), Number(duration.value) || t.min),
      ),
    );
    const chosen = delivery.value;
    delivery.innerHTML =
      option("standard", "Standard") +
      (config.expressEnabled && base === "scene"
        ? option("express", "Express")
        : "");
    if (chosen === "express" && config.expressEnabled && base === "scene")
      delivery.value = chosen;
    const s = service();
    $("#duration-note")!.textContent =
      "One allowance makes one video. A shorter video still uses one allowance.";
    $("#preview-duration")!.textContent = `${duration.value}-second video`;
    $("#preview-resolution")!.textContent = resolution.value.toUpperCase();
    $("#presenter-options")!.hidden = s !== "presenter";
    $("#scene-input-note")!.hidden = s === "presenter";
    $("#voice-field")!.hidden = source.value !== "ai";
    $("#audio-field")!.hidden = source.value !== "upload";
    const previous = allowance.value;
    allowance.innerHTML =
      option("", "Choose a compatible allowance") +
      allowances
        .filter(
          (a) =>
            a.videosRemaining > 0 &&
            compatible(
              a,
              t.id,
              s,
              Number(duration.value),
              resolution.value as Resolution,
            ),
        )
        .map((a) => option(a.id, `${a.name} · ${a.videosRemaining} remaining`))
        .join("");
    if ([...allowance.options].some((o) => o.value === previous))
      allowance.value = previous;
    else if (allowance.options.length === 2) allowance.selectedIndex = 1;
    const imagePrevious = imageAllowance.value;
    imageAllowance.innerHTML =
      option("", "Choose an image allowance") +
      allowances
        .filter((a) => a.portraitsRemaining > 0)
        .map((a) =>
          option(
            a.id,
            `${a.name} · ${a.portraitsRemaining} image preparation${a.portraitsRemaining === 1 ? "" : "s"}`,
          ),
        )
        .join("");
    if ([...imageAllowance.options].some((o) => o.value === imagePrevious))
      imageAllowance.value = imagePrevious;
    else if (imageAllowance.options.length > 1)
      imageAllowance.selectedIndex = 1;
    $("#script-count")!.textContent =
      `${script.value.trim().split(/\s+/).filter(Boolean).length} words · about ${Math.ceil(script.value.trim().split(/\s+/).filter(Boolean).length / 2.5)} seconds of speech (estimate)`;
    generate.disabled =
      running ||
      !config.generationEnabled ||
      !selectedAllowance() ||
      !approved.checked ||
      !direction.value.trim() ||
      images.length > 1 ||
      (s === "presenter" &&
        (!images.length || (!script.value.trim() && source.value === "ai"))) ||
      (["demo", "unboxing", "showcase"].includes(t.id) && !images.length);
    const chosenImage = library.assets.find((a) => a.id === images[0]);
    const preview = $("#preview-stage")!;
    if (chosenImage)
      preview.innerHTML = `<img src="${assetUrl(chosenImage)}" alt="Selected reference" style="width:100%;height:100%;object-fit:contain"/>`;
    $("#image-counter")!.textContent =
      `${images.length} selected${images.length > 1 ? " · combine before video" : ""}`;
    $("#image-choices")!.innerHTML = library.assets
      .filter((a) => a.kind === "image")
      .map(
        (a) =>
          `<button type="button" class="asset-choice ${images.includes(a.id) ? "selected" : ""}" data-image-id="${escape(a.id)}" aria-pressed="${images.includes(a.id)}" aria-label="Use ${escape(a.name)}"><img src="${assetUrl(a)}" alt="${escape(a.name)}" loading="lazy"/></button>`,
      )
      .join("");
    const old = audio.value;
    audio.innerHTML =
      option("", "Choose saved narration") +
      library.assets
        .filter((a) => a.kind === "audio")
        .map((a) => option(a.id, `${a.name} · ${Math.round(a.duration || 0)}s`))
        .join("");
    audio.value = old;
    $("#studio-jobs")!.innerHTML = library.jobs.length
      ? jobsMarkup(library.jobs)
      : '<p class="muted">Your generation progress will appear here.</p>';
  };
  const refresh = async () => {
    const [l, p, c] = await Promise.all([
      api<Library>("/api/library"),
      api("/api/purchases"),
      api<Config>("/api/config"),
    ]);
    library = l;
    allowances = p.allowances;
    config = c;
    $<HTMLSelectElement>("#voice-id")!.innerHTML = config.voices
      .map((v) => option(v.id, v.name))
      .join("");
    render();
    const notice = $("#studio-availability")!;
    notice.hidden = config.generationEnabled;
    if (!notice.hidden)
      notice.textContent =
        config.reason ||
        "Generation is currently unavailable. Your allowances are safe.";
  };
  const watch = async (id: string) => {
    try {
      const { job } = await api<{ job: Job }>(`/api/jobs/${id}`);
      const status = $("#generation-status")!;
      status.hidden = false;
      status.textContent =
        statusLabel(job.status) + (job.error ? ": " + job.error : "");
      if (job.status === "completed") {
        if (job.assetId && job.kind !== "portrait") {
          status.innerHTML = `<video controls playsinline src="/api/media/${encodeURIComponent(job.assetId)}" style="width:100%"></video><a class="button secondary full" href="/api/media/${encodeURIComponent(job.assetId)}?download=1" download>Download video</a>`;
        }
        await refresh();
        if (job.kind === "portrait" && job.assetId) {
          try {
            const prepared = await preparePortraitAsset(job.assetId);
            await refresh();
            images = [prepared.id];
          } catch {
            images = [job.assetId];
            $("#portrait-status")!.textContent =
              "Your original image is saved. Automatic resizing could not finish; review its framing before use.";
          }
          render();
        }
        return;
      }
      if (job.status === "failed" || job.status === "uncertain") {
        await refresh();
        return;
      }
      polling = setTimeout(() => void watch(id), 5000);
    } catch {
      polling = setTimeout(() => void watch(id), 10000);
    }
  };
  try {
    await refresh();
    const requested = new URLSearchParams(location.search).get("allowance");
    const a = allowances.find((v) => v.id === requested);
    if (a && a.service !== "image" && !a.legacy) {
      task.value = (a as any).taskType || "presenter";
      style.value = a.service === "presenter" ? "presenter" : "scene";
      duration.value = String(a.maxDuration);
      resolution.value = a.resolution;
      render();
      if (a.service === "express") delivery.value = "express";
      render();
      allowance.value = a.id;
    }
    const requestedImage = new URLSearchParams(location.search).get("image");
    if (library.assets.some((a) => a.id === requestedImage))
      images = [requestedImage!];
    const draft = sessionStorage.getItem("ahab-draft-prompt");
    if (draft) {
      direction.value = draft;
      sessionStorage.removeItem("ahab-draft-prompt");
    }
    render();
    for (const job of library.jobs.filter(
      (j) => !["completed", "failed", "uncertain"].includes(j.status),
    ))
      void watch(job.id);
  } catch (e) {
    $("#generation-error")!.textContent = showError(e);
  }
  form.addEventListener("input", (e) => {
    if ((e.target as HTMLElement).id === "prompt")
      rawDirection = direction.value;
    if ((e.target as HTMLElement).id !== "approved") approved.checked = false;
    if (
      (e.target as HTMLElement).id === "duration" &&
      !duration.checkValidity()
    )
      return;
    render();
  });
  form.addEventListener("change", () => render());
  $("#image-choices")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-image-id]");
    if (!b) return;
    const id = b.dataset.imageId!;
    if (images.includes(id)) images = images.filter((v) => v !== id);
    else images = images.length < 2 ? [...images, id] : [id];
    approved.checked = false;
    render();
  });
  $$<HTMLInputElement>("[data-upload]").forEach((input) =>
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      input.disabled = true;
      const out = $("#upload-status")!;
      try {
        out.textContent = "Saving your file…";
        const body = new FormData();
        body.set("file", file);
        body.set("kind", input.dataset.upload!);
        const r = await api("/api/media", { method: "POST", body });
        await refresh();
        if (r.asset.kind === "image") images = [r.asset.id];
        if (r.asset.kind === "audio") audio.value = r.asset.id;
        out.textContent = "Saved to your library.";
        render();
      } catch (e) {
        out.textContent = showError(e);
      } finally {
        input.value = "";
        input.disabled = false;
      }
    }),
  );
  $("#save-prompt")!.addEventListener("click", async () => {
    try {
      await post("/api/prompts", { text: direction.value });
      toast("Prompt saved.");
    } catch (e) {
      toast(showError(e));
    }
  });
  $("#prepare-text")!.addEventListener("click", async () => {
    const button = $<HTMLButtonElement>("#prepare-text")!;
    button.disabled = true;
    const out = $("#prepare-status")!;
    try {
      out.textContent = "Preparing your script and shot plan…";
      const r = await post("/api/prepare", {
        allowanceId: allowance.value,
        requestKey: preparationKey,
        prompt: direction.value,
        userPrompt: rawDirection || direction.value,
        script: script.value,
        wording: $<HTMLSelectElement>("#wording")!.value,
        style: $<HTMLSelectElement>("#delivery-style")!.value,
        taskType: task.value,
        duration: Number(duration.value),
      });
      if (!rawDirection) rawDirection = direction.value;
      shotPlan = r.preparation.shots;
      script.value = r.preparation.script;
      direction.value = r.preparation.direction;
      const shots = $("#shot-plan")!;
      shots.hidden = false;
      shots.innerHTML = `<strong>Suggested shot plan</strong><ol>${r.preparation.shots.map((s: string) => `<li>${escape(s)}</li>`).join("")}</ol>`;
      out.textContent = "Review or edit this before generating.";
      approved.checked = false;
      preparationKey = crypto.randomUUID();
      render();
    } catch (e) {
      out.textContent = showError(e);
    } finally {
      button.disabled = false;
    }
  });
  $("#create-portrait")!.addEventListener("click", async () => {
    const button = $<HTMLButtonElement>("#create-portrait")!;
    button.disabled = true;
    try {
      const r = await post("/api/portraits", {
        allowanceId: imageAllowance.value,
        requestKey: imageKey,
        prompt: $<HTMLTextAreaElement>("#portrait-prompt")!.value,
        imageIds: images,
        modify: images.length > 0,
      });
      imageKey = crypto.randomUUID();
      $("#portrait-status")!.textContent =
        "Preparing your image. Progress appears in your studio.";
      void watch(r.job.id);
      await refresh();
    } catch (e) {
      $("#portrait-status")!.textContent = showError(e);
    } finally {
      button.disabled = false;
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (running) return;
    running = true;
    render();
    try {
      const r = await post("/api/generate", {
        allowanceId: allowance.value,
        requestKey: key,
        taskType: task.value,
        service: service(),
        resolution: resolution.value,
        duration: Number(duration.value),
        prompt: direction.value,
        userPrompt: rawDirection || direction.value,
        script: script.value,
        imageIds: images,
        shots: shotPlan,
        approved: approved.checked,
        ...(service() === "presenter"
          ? source.value === "upload"
            ? { audioId: audio.value }
            : { voiceId: $<HTMLSelectElement>("#voice-id")!.value }
          : {}),
        caption: $<HTMLInputElement>("#caption")!.checked,
      });
      key = crypto.randomUUID();
      approved.checked = false;
      $("#generation-error")!.textContent = "";
      void watch(r.job.id);
      await refresh();
    } catch (e) {
      $("#generation-error")!.textContent = showError(e);
    } finally {
      running = false;
      render();
    }
  });
  window.addEventListener("pagehide", () => clearTimeout(polling));
}
void initializeLibrary();
void initializePurchases();
void initializeOffers();
void initializeStudio();
