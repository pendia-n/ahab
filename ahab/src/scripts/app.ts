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
  const payload: any = await response
    .json()
    .catch(() => ({
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
    uncertain: "Checking provider status",
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

async function initializePurchases() {
  if (!$("#purchase-history")) return;
  let checkoutEnabled = false;
  const history = $("#purchase-history")!;
  try {
    const result = await api("/api/purchases");
    let config: Config;
    try {
      config = await api("/api/config");
    } catch {
      config = { voices: [], generationEnabled: false, checkoutEnabled: false };
    }
    checkoutEnabled = result.checkoutEnabled ?? config.checkoutEnabled;
    const availability = $("#checkout-availability")!;
    availability.textContent = checkoutEnabled
      ? config.usdcEnabled
        ? "Secure checkout with Stripe. Eligible card and USDC options are shown at checkout."
        : "Secure checkout with Stripe. Available payment methods are shown at checkout."
      : (config.checkoutReason || "Checkout is temporarily unavailable. Please try again shortly.");
    $$<HTMLButtonElement>("[data-checkout]").forEach((button) => {
      button.disabled = !checkoutEnabled;
      button.innerHTML = checkoutEnabled
        ? "Choose this package →"
        : "Not available yet";
    });
    const allowances: Allowance[] = result.allowances || [];
    if (allowances.length) {
      $("#your-allowances")!.hidden = false;
      $("#allowance-cards")!.innerHTML = allowances
        .map(
          (item) =>
            `<article class="allowance-card"><h3>${escape(item.name || item.packageId)}</h3><p>${item.videosRemaining} video${item.videosRemaining === 1 ? "" : "s"} · up to ${item.maxDuration}s each<br/>${item.portraitsRemaining} portrait${item.portraitsRemaining === 1 ? "" : "s"} remaining</p><a href="/studio?allowance=${encodeURIComponent(item.id)}" class="text-link" style="font-size:12px">Use in studio →</a></article>`,
        )
        .join("");
    }
    const purchases = result.purchases || [];
    history.innerHTML = purchases.length
      ? `<table class="data-table"><thead><tr><th>Package</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>${purchases.map((item: any) => `<tr><td>${escape(item.name || item.packageId)}</td><td>${date(item.createdAt)}</td><td>$${(Number(item.amountCents) / 100).toFixed(2)} USD</td><td><span class="pill ${item.status === "paid" ? "green" : ""}">${escape(item.status)}</span></td></tr>`).join("")}</tbody></table>`
      : '<p class="muted" style="font-size:12px">No purchases yet. Choose a package when you are ready to make your first take.</p>';
    const params = new URLSearchParams(location.search);
    if (params.has("session_id") || params.get("checkout") === "success") {
      const message = $("#purchase-message")!;
      message.hidden = false;
      message.textContent =
        "Thanks. Your payment is being verified. Allowances appear here once it is confirmed. If they have not arrived yet, refresh in a moment.";
    }
    if (params.get("checkout") === "cancelled") {
      const message = $("#purchase-message")!;
      message.hidden = false;
      message.textContent =
        "Checkout was closed. No new allowance has been added.";
    }
  } catch (error) {
    history.textContent = showError(error);
    $("#checkout-availability")!.textContent =
      "Payment availability could not be checked. Refresh to try again.";
  }
  $$<HTMLButtonElement>("[data-checkout]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (!checkoutEnabled) return;
      button.disabled = true;
      try {
        const result = await post("/api/checkout", {
          packageId: button.dataset.checkout,
        });
        const url = new URL(result.url);
        if (
          url.protocol !== "https:" ||
          !["checkout.stripe.com", "buy.stripe.com"].includes(url.hostname)
        )
          throw new Error("The checkout link could not be verified.");
        location.assign(url.href);
      } catch (error) {
        toast(showError(error));
        button.disabled = false;
      }
    }),
  );
}

async function mediaDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const media = document.createElement(
      file.type.startsWith("video/") ? "video" : "audio",
    );
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      URL.revokeObjectURL(url);
      media.removeAttribute("src");
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "The file duration could not be read. Try a standard MP3, WAV or MP4 file.",
        ),
      );
    }, 15000);
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      clearTimeout(timer);
      const duration = media.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0)
        reject(new Error("This file does not have a valid duration."));
      else resolve(duration);
    };
    media.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(
        new Error(
          "This media format could not be read. Try a standard MP3, WAV or MP4 file.",
        ),
      );
    };
    media.src = url;
  });
}

async function initializeStudio() {
  const form = $<HTMLFormElement>("#generate-form");
  if (!form) return;
  let library: Library = { assets: [], prompts: [], jobs: [] };
  let allowances: Allowance[] = [];
  let config: Config = {
    voices: [],
    generationEnabled: false,
    checkoutEnabled: false,
    maxPresenterDuration: 30,
  };
  let mode: "presenter" | "video_reference" = "presenter";
  let selectedImages: string[] = [];
  let uploading = false;
  let generating = false;
  let portraitPending = false;
  let pollTimer: ReturnType<typeof setTimeout>;
  const allowanceSelect = $<HTMLSelectElement>("#allowance")!;
  const durationSelect = $<HTMLSelectElement>("#duration")!;
  const audioSelect = $<HTMLSelectElement>("#audio-reference")!;
  const videoSelect = $<HTMLSelectElement>("#video-reference")!;
  const sourceSelect = $<HTMLSelectElement>("#voice-source")!;
  const script = $<HTMLTextAreaElement>("#script")!;
  const direction = $<HTMLTextAreaElement>("#prompt")!;
  const voice = $<HTMLSelectElement>("#voice-id")!;
  const aspect = $<HTMLSelectElement>("#aspect-ratio")!;
  const generateButton = $<HTMLButtonElement>("#generate-button")!;
  const currentAllowance = () =>
    allowances.find((item) => item.id === allowanceSelect.value);
  const draft = sessionStorage.getItem("ahab-draft-prompt");
  if (draft) {
    direction.value = draft;
    sessionStorage.removeItem("ahab-draft-prompt");
  }
  const renderAssets = () => {
    $("#image-choices")!.innerHTML = library.assets
      .filter((asset) => asset.kind === "image")
      .map(
        (asset) =>
          `<button class="asset-choice ${selectedImages.includes(asset.id) ? "selected" : ""}" type="button" aria-label="Use ${escape(asset.name || "reference image")}" aria-pressed="${selectedImages.includes(asset.id)}" data-image-id="${escape(asset.id)}"><img src="${assetUrl(asset)}" alt="${escape(asset.name || "Saved reference")}" loading="lazy"/></button>`,
      )
      .join("");
    $("#image-counter")!.textContent =
      `${selectedImages.length} selected${mode === "video_reference" ? " · up to 2" : ""}`;
    const audioValue = audioSelect.value;
    audioSelect.innerHTML =
      '<option value="">' +
      (mode === "presenter" ? "Choose saved narration" : "No audio reference") +
      "</option>" +
      library.assets
        .filter((asset) => asset.kind === "audio")
        .map(
          (asset) =>
            `<option value="${escape(asset.id)}">${escape(asset.name || "Audio")} · ${Math.round(asset.duration || 0)}s</option>`,
        )
        .join("");
    if (library.assets.some((asset) => asset.id === audioValue))
      audioSelect.value = audioValue;
    const videoValue = videoSelect.value;
    videoSelect.innerHTML =
      '<option value="">No video reference</option>' +
      library.assets
        .filter((asset) => asset.kind === "video")
        .map(
          (asset) =>
            `<option value="${escape(asset.id)}">${escape(asset.name || "Video reference")} · ${Math.round(asset.duration || 0)}s</option>`,
        )
        .join("");
    if (library.assets.some((asset) => asset.id === videoValue))
      videoSelect.value = videoValue;
    updatePreview();
  };
  const updatePreview = () => {
    const stage = $("#preview-stage")!;
    const image = library.assets.find((item) => item.id === selectedImages[0]);
    if (image)
      stage.innerHTML = `<img src="${assetUrl(image)}" alt="Your selected reference image"/><span class="preview-label">REFERENCE IMAGE · NOT A GENERATED VIDEO</span>`;
    else
      stage.innerHTML =
        '<div class="preview-placeholder"><span class="preview-mark">✧</span><strong>A little idea.<br/>A finished video.</strong><p>Select your face image<br/>to start setting the scene.</p></div>';
    stage.style.aspectRatio = aspect.value.replace(":", "/");
    $("#preview-format")!.textContent =
      aspect.value +
      " · " +
      (aspect.value === "9:16"
        ? "VERTICAL"
        : aspect.value === "16:9"
          ? "LANDSCAPE"
          : "SQUARE");
    $("#preview-duration")!.textContent =
      (mode === "presenter" ? "UP TO " : "") + durationSelect.value + " SEC";
    $("#preview-resolution")!.textContent =
      mode === "presenter" ? "720P" : "768P";
    const allowance = currentAllowance();
    $("#preview-package")!.textContent =
      allowance?.name || allowance?.packageId || "Choose a package";
    generateButton.disabled =
      !config.generationEnabled ||
      !allowance ||
      allowance.videosRemaining < 1 ||
      uploading ||
      generating;
    $("#create-portrait")!.toggleAttribute(
      "disabled",
      !config.generationEnabled ||
        !allowance ||
        allowance.portraitsRemaining < 1 ||
        generating ||
        portraitPending,
    );
    $("#portrait-help")!.textContent = allowance
      ? `${allowance.portraitsRemaining} portrait allowance${allowance.portraitsRemaining === 1 ? "" : "s"} remaining. Saved portraits count toward your 40 images.`
      : "Choose a package with a portrait allowance to create a presenter.";
  };
  const updateDuration = () => {
    const previous = Number(durationSelect.value);
    const max =
      mode === "video_reference"
        ? 15
        : Math.min(
            currentAllowance()?.maxDuration || 30,
            config.maxPresenterDuration || 30,
          );
    const values =
      mode === "video_reference"
        ? [5, 10, 15]
        : [15, 30, 45, 60, 80, 90, 120].filter((value) => value <= max);
    if (!values.length) values.push(Math.max(1, max));
    durationSelect.innerHTML = values
      .map(
        (value) =>
          `<option value="${value}">${mode === "presenter" ? "Up to " : ""}${value} seconds</option>`,
      )
      .join("");
    durationSelect.value = String(
      values.includes(previous) ? previous : values[values.length - 1],
    );
    $("#allowance-help")!.textContent = currentAllowance()
      ? `${currentAllowance()!.videosRemaining} video allowance${currentAllowance()!.videosRemaining === 1 ? "" : "s"} remaining · presenter maximum ${currentAllowance()!.maxDuration}s.`
      : "No available package yet. Choose a one-time package in Purchases.";
    updatePreview();
  };
  const switchMode = (next: "presenter" | "video_reference") => {
    mode = next;
    $<HTMLInputElement>("[name=mode]")!.value = mode;
    $$<HTMLButtonElement>("[data-mode]").forEach((button) =>
      button.setAttribute(
        "aria-selected",
        String(button.dataset.mode === mode),
      ),
    );
    $("#scene-options")!.hidden = mode === "presenter";
    $("#presenter-options")!.hidden = mode !== "presenter";
    $("#caption-field")!.hidden = mode !== "presenter";
    $("#mode-description")!.textContent =
      mode === "presenter"
        ? "A talking presenter made from one face image and your script or narration. Best for an introduction, explainer or new ad hook."
        : "A short scene guided by your direction and optional references. Up to two images, one 5-second video and one 15-second audio reference.";
    $("#image-heading")!.textContent =
      mode === "presenter" ? "Give it a face" : "Set your visual references";
    $("#image-help")!.textContent =
      mode === "presenter"
        ? "Choose one clear portrait. Use a face you have permission to use."
        : "Choose up to two images to guide your scene. Images are optional when you describe the scene clearly.";
    $("#direction-optional")!.hidden = true;
    $("#direction-help")!.textContent =
      mode === "presenter"
        ? "Describe delivery and motion. Your script stays separate so your presenter knows what to say."
        : "Describe the scene, action and camera movement. References guide the result; exact actions are not guaranteed.";
    direction.placeholder =
      mode === "presenter"
        ? "Keep it warm and natural, like explaining something to a friend."
        : "A creator opens a small parcel at a kitchen counter, pauses, then reacts with a delighted smile. Natural handheld camera…";
    $("#duration-note")!.textContent =
      mode === "presenter"
        ? "Vertical video fits TikTok and Shorts. Choose a duration that gives your script room; speech timing can vary."
        : "One clip uses one video allowance. Longer clips and automatic stitching are not available.";
    if (mode === "presenter") selectedImages = selectedImages.slice(0, 1);
    updateAudio();
    renderAssets();
    updateDuration();
  };
  const updateAudio = () => {
    const uploaded =
      mode === "video_reference" || sourceSelect.value === "upload";
    $("#audio-field")!.hidden = !uploaded;
    $("#voice-field")!.hidden = uploaded;
    $("#script-field")!.hidden = uploaded;
    $("#audio-label")!.textContent =
      mode === "presenter"
        ? "Uploaded narration"
        : "Audio reference · optional";
    $("#audio-help")!.textContent =
      mode === "presenter"
        ? "Your recording supplies the presenter’s voice. It must fit your selected duration."
        : "Ahab accepts references up to 15 seconds. It guides the scene; exact voice or lip-sync is not promised.";
    $("#audio-upload-heading")!.textContent =
      mode === "presenter"
        ? "Upload your narration"
        : "Upload a scene audio reference";
    $("#audio-upload-limits")!.textContent =
      `MP3 or WAV · ${mode === "video_reference" ? "up to 15 seconds and " : ""}16 MB`;
  };
  const renderJobs = () => {
    const active = library.jobs.filter(
      (job) => !["failed", "completed"].includes(job.status),
    );
    $("#recent-jobs")!.hidden = !active.length;
    $("#studio-jobs")!.innerHTML = jobsMarkup(active);
  };
  const refresh = async () => {
    const [lib, purchases] = await Promise.all([
      api<Library>("/api/library"),
      api("/api/purchases"),
    ]);
    library = {
      assets: lib.assets || [],
      prompts: lib.prompts || [],
      jobs: lib.jobs || [],
    };
    allowances = purchases.allowances || [];
    const selected =
      allowanceSelect.value ||
      new URLSearchParams(location.search).get("allowance");
    allowanceSelect.innerHTML =
      allowances
        .filter(
          (item) => item.videosRemaining > 0 || item.portraitsRemaining > 0,
        )
        .map(
          (item) =>
            `<option value="${escape(item.id)}">${escape(item.name || item.packageId)} · ${item.videosRemaining} video${item.videosRemaining === 1 ? "" : "s"} left · up to ${item.maxDuration}s</option>`,
        )
        .join("") ||
      '<option value="">No package yet — visit Purchases</option>';
    if (allowances.some((item) => item.id === selected))
      allowanceSelect.value = selected!;
    selectedImages = selectedImages.filter((id) =>
      library.assets.some((asset) => asset.id === id),
    );
    renderAssets();
    updateDuration();
    renderJobs();
  };
  const pollJob = async (id: string) => {
    clearTimeout(pollTimer);
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(id)}`);
      const job: Job = result.job || result;
      const node = $("#generation-status")!;
      node.hidden = false;
      if (job.status === "completed") {
        node.innerHTML =
          'Your take is ready. <a href="/library">Open your library to watch and download it →</a>';
        generating = false;
        await refresh();
        return;
      }
      if (job.status === "failed") {
        node.textContent =
          job.error ||
          "This generation failed. Its allowance has been restored.";
        generating = false;
        await refresh();
        return;
      }
      node.textContent =
        statusLabel(job.status) +
        ". You can leave this page; your take keeps going. Find it in your library.";
      pollTimer = setTimeout(() => pollJob(id), 6000);
    } catch {
      const node = $("#generation-status")!;
      node.hidden = false;
      node.innerHTML =
        'We could not check progress just now. <a href="/library">Check your library for the latest status.</a>';
      generating = false;
      updatePreview();
    }
  };
  try {
    config = await api<Config>("/api/config");
    config.voices ??= [];
    voice.innerHTML = config.voices.length
      ? config.voices
          .map(
            (item) =>
              `<option value="${escape(item.id)}">${escape(item.name)}</option>`,
          )
          .join("")
      : '<option value="">AI voices are not available yet</option>';
    if (!config.voices.length) {
      sourceSelect.value = "upload";
      updateAudio();
    }
    await refresh();
    const requestedImage = new URLSearchParams(location.search).get("image");
    if (
      requestedImage &&
      library.assets.some(
        (asset) => asset.id === requestedImage && asset.kind === "image",
      )
    ) {
      selectedImages = [requestedImage];
      renderAssets();
    }
    if (!config.generationEnabled) {
      const notice = $("#studio-availability")!;
      notice.hidden = false;
      notice.innerHTML =
        'Generation is not open yet. Explore the studio and save your references. <a class="text-link" href="/purchases">Payment availability is shown in Purchases.</a>';
    }
  } catch (error) {
    $("#generation-error")!.textContent = showError(error);
    $("#generation-error")!.classList.add("error");
  }
  $$<HTMLButtonElement>("[data-mode]").forEach((button) => {
    button.addEventListener("click", () =>
      switchMode(button.dataset.mode as "presenter" | "video_reference"),
    );
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const other = $$<HTMLButtonElement>("[data-mode]").find(
        (item) => item !== button,
      );
      if (other) {
        other.click();
        other.focus();
      }
    });
  });
  $("#image-choices")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-image-id]",
    );
    if (!button) return;
    const id = button.dataset.imageId!;
    if (selectedImages.includes(id))
      selectedImages = selectedImages.filter((item) => item !== id);
    else if (mode === "presenter") selectedImages = [id];
    else if (selectedImages.length < 2) selectedImages.push(id);
    else toast("Choose up to two reference images.");
    renderAssets();
  });
  sourceSelect.addEventListener("change", updateAudio);
  allowanceSelect.addEventListener("change", updateDuration);
  durationSelect.addEventListener("change", updatePreview);
  aspect.addEventListener("change", updatePreview);
  videoSelect.addEventListener("change", () => {
    if (videoSelect.value && mode !== "video_reference")
      switchMode("video_reference");
  });
  script.addEventListener("input", () => {
    const words = script.value.trim()
      ? script.value.trim().split(/\s+/).length
      : 0;
    $("#script-count")!.textContent =
      `${words} words · about ${Math.max(1, Math.round(words / 2.4))} seconds spoken`;
  });
  $("#portrait-toggle")?.addEventListener("click", () => {
    $("#portrait-fields")!.hidden = !$("#portrait-fields")!.hidden;
  });
  $("#save-prompt")?.addEventListener("click", async () => {
    if (!direction.value.trim()) {
      toast("Write a creative direction to save first.");
      return;
    }
    try {
      await post("/api/prompts", { text: direction.value });
      toast("Prompt saved to your library.");
    } catch (error) {
      toast(showError(error));
    }
  });
  $$<HTMLInputElement>("[data-upload]").forEach((input) =>
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      const kind = input.dataset.upload!;
      uploading = true;
      updatePreview();
      const node = $("#upload-status")!;
      node.textContent = "Checking and saving your file…";
      node.classList.remove("error");
      try {
        if (kind === "image") {
          if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
            throw new Error("Choose a JPG, PNG or WebP image.");
          if (file.size > 10 * 1024 * 1024)
            throw new Error("Images must be 10 MB or smaller.");
        } else {
          if (file.size > 16 * 1024 * 1024)
            throw new Error("Audio and video files must be 16 MB or smaller.");
        }
        const duration = kind === "image" ? 0 : await mediaDuration(file);
        const max =
          kind === "video"
            ? 5
            : mode === "video_reference"
              ? 15
              : Math.min(
                  currentAllowance()?.maxDuration || 30,
                  config.maxPresenterDuration || 30,
                );
        if (duration > max + 0.05)
          throw new Error(
            `${kind === "video" ? "Video references" : "This audio"} must be ${max} seconds or shorter.`,
          );
        const upload = new FormData();
        upload.set("file", file);
        upload.set("kind", kind);
        if (duration) upload.set("duration", String(duration));
        const result = await api("/api/media", {
          method: "POST",
          body: upload,
        });
        await refresh();
        const asset: Asset = result.asset || result;
        if (asset.id) {
          if (kind === "image")
            selectedImages =
              mode === "presenter"
                ? [asset.id]
                : [...selectedImages, asset.id].slice(-2);
          if (kind === "audio") audioSelect.value = asset.id;
          if (kind === "video") {
            switchMode("video_reference");
            videoSelect.value = asset.id;
          }
          renderAssets();
        }
        node.textContent = "Saved to your library.";
        toast("Reference saved.");
      } catch (error) {
        node.textContent = showError(error);
        node.classList.add("error");
      } finally {
        uploading = false;
        input.value = "";
        updatePreview();
      }
    }),
  );
  const pollPortrait = async (id: string) => {
    const node = $("#portrait-status")!;
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(id)}`);
      const job: Job = result.job || result;
      if (job.status === "completed") {
        portraitPending = false;
        await refresh();
        if (
          job.assetId &&
          library.assets.some((asset) => asset.id === job.assetId)
        ) {
          selectedImages = [job.assetId];
          renderAssets();
        }
        node.textContent = "Your portrait is ready and saved to your images.";
        return;
      }
      if (job.status === "failed") {
        portraitPending = false;
        await refresh();
        node.textContent =
          job.error ||
          "Portrait generation failed. Its allowance has been restored.";
        node.classList.add("error");
        return;
      }
      node.textContent =
        statusLabel(job.status) +
        ". You can leave this page and find the portrait in your library.";
      setTimeout(() => pollPortrait(id), 6000);
    } catch {
      portraitPending = false;
      node.textContent =
        "Progress could not be checked. Check your library before trying again.";
      updatePreview();
    }
  };
  $("#create-portrait")?.addEventListener("click", async () => {
    const button = $<HTMLButtonElement>("#create-portrait")!;
    const node = $("#portrait-status")!;
    const prompt = $<HTMLTextAreaElement>("#portrait-prompt")!.value.trim();
    if (!prompt) {
      node.textContent = "Describe the presenter you want to create.";
      node.classList.add("error");
      return;
    }
    button.disabled = true;
    portraitPending = true;
    node.classList.remove("error");
    node.textContent =
      "Creating your portrait. This uses one portrait allowance.";
    try {
      const result = await post("/api/portraits", {
        allowanceId: allowanceSelect.value,
        prompt,
        aspectRatio: "9:16",
      });
      if (result.asset?.id) {
        portraitPending = false;
        await refresh();
        selectedImages = [result.asset.id];
        renderAssets();
        node.textContent = "Your portrait is ready and selected.";
      } else if (result.job?.id || result.id) {
        node.textContent =
          "Your portrait is being made. It will appear in your library.";
        void pollPortrait(result.job?.id || result.id);
      } else {
        portraitPending = false;
        await refresh();
        node.textContent =
          "Your portrait request was accepted. Check your library.";
      }
    } catch (error) {
      portraitPending = false;
      node.textContent = showError(error);
      node.classList.add("error");
    } finally {
      updatePreview();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorNode = $("#generation-error")!;
    errorNode.textContent = "";
    errorNode.classList.remove("error");
    const narration = mode === "presenter" && sourceSelect.value === "upload";
    try {
      if (!currentAllowance())
        throw new Error("Choose a package in Purchases before generating.");
      if (mode === "presenter" && selectedImages.length !== 1)
        throw new Error("Choose one face image for your presenter.");
      if (mode === "presenter" && !narration && !script.value.trim())
        throw new Error("Write what your presenter should say.");
      if (mode === "presenter" && !narration && !voice.value)
        throw new Error("Choose a supported AI voice or upload narration.");
      if (narration && !audioSelect.value)
        throw new Error("Choose or upload your narration.");
      if (!direction.value.trim())
        throw new Error(
          mode === "video_reference"
            ? "Describe the scene you want to create."
            : "Add a little creative direction for your presenter’s delivery.",
        );
      const audio = library.assets.find(
        (asset) => asset.id === audioSelect.value,
      );
      if (
        audio &&
        audio.duration &&
        audio.duration >
          (mode === "video_reference" ? 15 : Number(durationSelect.value)) +
            0.05
      )
        throw new Error(
          "Your audio is longer than this take. Choose a shorter recording or a longer presenter duration.",
        );
      generating = true;
      updatePreview();
      const body = {
        allowanceId: allowanceSelect.value,
        mode,
        prompt: direction.value.trim(),
        ...(mode === "presenter" && !narration
          ? { script: script.value.trim(), voiceId: voice.value }
          : {}),
        imageIds: selectedImages,
        ...((mode === "video_reference" || narration) && audioSelect.value
          ? { audioId: audioSelect.value }
          : {}),
        ...(mode === "video_reference" && videoSelect.value
          ? { videoId: videoSelect.value }
          : {}),
        duration: Number(durationSelect.value),
        aspectRatio: aspect.value,
        caption:
          mode === "presenter" &&
          $<HTMLInputElement>("[name=caption]")!.checked,
      };
      const result = await post("/api/generate", body);
      const id = result.job?.id || result.id;
      if (!id)
        throw new Error(
          "Your request was accepted but its progress link is unavailable. Check your library before trying again.",
        );
      const node = $("#generation-status")!;
      node.hidden = false;
      node.textContent =
        "Your take is queued. You can leave this page; it keeps going in the background.";
      await refresh();
      pollJob(id);
    } catch (error) {
      errorNode.textContent = showError(error);
      errorNode.classList.add("error");
      generating = false;
      updatePreview();
    }
  });
}
void initializeLibrary();
void initializePurchases();
void initializeStudio();
