const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) =>
  Array.from(root.querySelectorAll(selector));

const page = document.body.dataset.page;
const apiBaseUrl = String(window.APP_CONFIG?.apiBaseUrl || "").replace(
  /\/+$/,
  "",
);

const state = {
  quiz: {
    participant: null,
    questions: [],
    current: 0,
    answers: [],
    startedAt: 0,
    timerId: null,
    inProgress: false,
  },
  adminToken: localStorage.getItem("gbAdminToken") || "",
  adminLeaderboard: [],
  adminQuestions: [],
  adminPhotos: [],
  adminPages: { photos: 1, messages: 1, contacts: 1, questions: 1, leaderboard: 1 },
  adminQuestionOrderDirty: false,
  gallery: { page: 1, search: "", selecting: false, selected: new Set() },
};

document.addEventListener("DOMContentLoaded", () => {
  document.body.classList.add("loaded");

  initNavigation();
  initRevealAnimations();
  initMapFrames();
  initDecorativeHearts();

  if (page === "home") initHome();
  if (page === "album") initAlbum();
  if (page === "admin") initAdmin();
});

function initNavigation() {
  const header = $("[data-header]");
  const toggle = $("[data-nav-toggle]");
  const nav = $("[data-nav]");

  const onScroll = () => {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 18);
  };

  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  toggle?.addEventListener("click", () => {
    document.body.classList.toggle("nav-open");
    nav?.classList.toggle("visible");
  });

  nav?.addEventListener("click", (event) => {
    if (event.target.matches("a")) {
      document.body.classList.remove("nav-open");
      nav.classList.remove("visible");
    }
  });

  $("[data-floating-upload]")?.addEventListener("click", () => {
    window.location.href = "album.html#upload";
  });
}

function initRevealAnimations() {
  const items = $$(".reveal");
  if (!items.length) return;
  if (!("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 },
  );

  items.forEach((item) => observer.observe(item));
}

function initMapFrames() {
  $$("[data-map-query]").forEach((frame) => {
    const query = encodeURIComponent(
      frame.dataset.mapQuery || "Gloria Beniamino matrimonio",
    );
    frame.innerHTML = `<button class="map-load" type="button">Mostra la mappa interattiva</button>`;
    $("button", frame)?.addEventListener("click", () => {
      frame.innerHTML = `<iframe title="Mappa interattiva" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://maps.google.com/maps?q=${query}&t=&z=14&ie=UTF8&iwloc=&output=embed"></iframe>`;
    });
  });
}

function initDecorativeHearts() {
  const prefersLessMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersLessMotion || navigator.connection?.saveData) return;
  const sections = $$(".hero, main > .section, main > .upload-section");
  sections.forEach((section) => {
    const hearts = document.createElement("div");
    hearts.className = "floating-hearts";
    hearts.setAttribute("aria-hidden", "true");
    hearts.innerHTML = Array.from({ length: 2 }, (_, index) => {
      const x = index === 0 ? Math.round(Math.random() * 8 + 2) : Math.round(Math.random() * 8 + 90);
      const y = Math.round(Math.random() * 76 + 12);
      const delay = (Math.random() * -10).toFixed(1);
      const duration = (9 + Math.random() * 7).toFixed(1);
      return `<span style="--x:${x}%;--y:${y}%;--delay:${delay}s;--duration:${duration}s">♥</span>`;
    }).join("");
    section.appendChild(hearts);
  });
}

async function api(path, options = {}) {
  const headers = {
    ...(options.body instanceof FormData
      ? {}
      : { "Content-Type": "application/json" }),
    ...(options.headers || {}),
  };

  if (options.admin !== false && state.adminToken) {
    headers.Authorization = `Bearer ${state.adminToken}`;
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
    body:
      options.body &&
      !(options.body instanceof FormData) &&
      typeof options.body !== "string"
        ? JSON.stringify(options.body)
        : options.body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || "Operazione non riuscita.");
  }

  return data;
}

function initHome() {
  loadPhotoCarousel();
  initCarouselControls();
  initQuiz();
  initMessageForm();
  initContactForm();

  window.setInterval(() => {
    if (!document.hidden) loadPhotoCarousel();
  }, 60000);
}

async function loadPhotoCarousel() {
  const carousel = $("[data-photo-carousel]");
  if (!carousel) return;

  try {
    const data = await api("/api/photos?limit=10", { admin: false });
    const photos = data.photos || [];

    if (!photos.length) {
      carousel.innerHTML = emptyAlbumMarkup();
      carousel.closest(".carousel-shell")?.classList.add("is-empty");
      return;
    }

    carousel.closest(".carousel-shell")?.classList.remove("is-empty");
    carousel.innerHTML = photos
      .map(
        (photo) => `
        <article class="carousel-card">
          <img src="${escapeAttr(photo.url)}" alt="Foto caricata da ${escapeAttr(photo.uploaderName)}" loading="lazy">
          <span class="photo-badge"><strong>${escapeHtml(photo.uploaderName)}</strong><small>${formatDate(photo.createdAt)}</small></span>
        </article>
      `,
      )
      .join("");
  } catch (error) {
    carousel.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function initCarouselControls() {
  const carousel = $("[data-photo-carousel]");
  if (!carousel) return;

  $("[data-carousel-prev]")?.addEventListener("click", () => {
    carousel.scrollBy({ left: -320, behavior: "smooth" });
  });

  $("[data-carousel-next]")?.addEventListener("click", () => {
    carousel.scrollBy({ left: 320, behavior: "smooth" });
  });
}

function initMessageForm() {
  const form = $("[data-message-form]");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = $("[data-message-status]");
    const data = {
      ...Object.fromEntries(new FormData(form).entries()),
      type: "guestbook",
    };

    try {
      status.textContent = "Invio in corso...";
      await api("/api/messages", {
        method: "POST",
        body: data,
        admin: false,
      });
      form.reset();
      status.textContent = "Messaggio inviato. Grazie!";
      showSuccessDialog(
        "Messaggio inviato",
        "Grazie per aver lasciato un pensiero per noi.",
      );
    } catch (error) {
      status.textContent = error.message;
    }
  });
}

function initContactForm() {
  const form = $("[data-contact-form]");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = $("[data-contact-status]");
    const data = {
      ...Object.fromEntries(new FormData(form).entries()),
      type: "contact",
    };
    try {
      status.textContent = "Invio in corso...";
      await api("/api/messages", { method: "POST", body: data, admin: false });
      form.reset();
      status.textContent = "Richiesta inviata. Grazie!";
      showSuccessDialog(
        "Richiesta inviata",
        "Grazie! Leggeremo il tuo messaggio con piacere.",
      );
    } catch (error) {
      status.textContent = error.message;
    }
  });
}

async function initQuiz() {
  const form = $("[data-quiz-start-form]");
  if (!form) return;

  try {
    const data = await api("/api/quiz/questions", { admin: false });
    state.quiz.questions = data.questions || [];
    state.quiz.answers = new Array(state.quiz.questions.length).fill(null);
  } catch (error) {
    form.insertAdjacentHTML(
      "afterend",
      `<p class="form-note">${escapeHtml(error.message)}</p>`,
    );
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const participant = Object.fromEntries(new FormData(form).entries());
    state.quiz.participant = {
      name: participant.name.trim(),
      surname: participant.surname.trim(),
    };
    state.quiz.current = 0;
    state.quiz.answers = new Array(state.quiz.questions.length).fill(null);

    if (!state.quiz.questions.length) {
      showQuizResult("Il quiz non ha ancora domande. Riprova più tardi.");
      return;
    }

    const startAlert = $("[data-quiz-start-alert]");
    try {
      const check = await api(
        `/api/quiz/participation?name=${encodeURIComponent(state.quiz.participant.name)}&surname=${encodeURIComponent(state.quiz.participant.surname)}`,
        { admin: false },
      );
      if (check.participated) {
        startAlert?.classList.remove("hidden");
        $("h3", startAlert).textContent =
          "Hai gia partecipato al quiz. Chiedi agli sposi se vuoi riprovare.";
        return;
      }
    } catch (error) {
      startAlert?.classList.remove("hidden");
      $("h3", startAlert).textContent = error.message;
      return;
    }

    startAlert?.classList.add("hidden");
    state.quiz.startedAt = performance.now();
    state.quiz.inProgress = true;
    form.classList.add("hidden");
    $("[data-quiz-box]")?.classList.remove("hidden");
    startQuizTimer();
    renderQuizQuestion();
  });

  $("[data-quiz-prev]")?.addEventListener("click", () => {
    if (state.quiz.current > 0) {
      state.quiz.current -= 1;
      renderQuizQuestion();
    }
  });

  $("[data-quiz-next]")?.addEventListener("click", async () => {
    const total = state.quiz.questions.length;
    if (state.quiz.answers[state.quiz.current] === null) return;

    if (state.quiz.current < total - 1) {
      state.quiz.current += 1;
      renderQuizQuestion();
      return;
    }

    await submitQuiz();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.quiz.inProgress) return;
    event.preventDefault();
    event.returnValue = "Se ricarichi la pagina il tentativo verra segnato 0/0 e non potrai rifare il quiz.";
  });

  window.addEventListener("pagehide", () => {
    if (!state.quiz.inProgress || !state.quiz.participant) return;
    const payload = JSON.stringify(state.quiz.participant);
    navigator.sendBeacon(
      "/api/quiz/abandon",
      new Blob([payload], { type: "application/json" }),
    );
  });
}

function renderQuizQuestion() {
  const question = state.quiz.questions[state.quiz.current];
  const total = state.quiz.questions.length;

  $("[data-quiz-counter]").textContent =
    `Domanda ${state.quiz.current + 1} di ${total}`;
  $("[data-quiz-progress]").style.width =
    `${((state.quiz.current + 1) / total) * 100}%`;
  $("[data-quiz-intro]").textContent = question.intro || "";
  $("[data-quiz-question]").textContent = question.question;

  const answersRoot = $("[data-quiz-answers]");
  answersRoot.innerHTML = question.answers
    .map(
      (answer, index) => `
      <button class="answer-option ${state.quiz.answers[state.quiz.current] === index ? "selected" : ""}" type="button" data-answer-index="${index}">
        ${escapeHtml(answer)}
      </button>
    `,
    )
    .join("");

  $$("[data-answer-index]", answersRoot).forEach((button) => {
    button.addEventListener("click", () => {
      state.quiz.answers[state.quiz.current] = Number(
        button.dataset.answerIndex,
      );
      renderQuizQuestion();
    });
  });

  $("[data-quiz-prev]").disabled = state.quiz.current === 0;
  $("[data-quiz-next]").textContent =
    state.quiz.current === total - 1 ? "Invia risposte" : "Avanti";
}

async function submitQuiz() {
  stopQuizTimer();
  state.quiz.inProgress = false;
  const payload = {
    ...state.quiz.participant,
    elapsedMs: Math.round(performance.now() - state.quiz.startedAt),
    answers: state.quiz.questions.map((question, index) => ({
      questionId: question.id,
      answerIndex: state.quiz.answers[index],
    })),
  };

  try {
    const data = await api("/api/quiz/submit", {
      method: "POST",
      body: payload,
      admin: false,
    });

    const result = data.result;
    $("[data-quiz-box]")?.classList.add("hidden");
    showQuizResult(
      `Hai risposto correttamente a ${result.correctAnswers}/${result.total} domande.`,
    );
  } catch (error) {
    showQuizResult(error.message);
  }
}

function startQuizTimer() {
  stopQuizTimer();
  const timer = $("[data-quiz-timer]");
  const update = () => {
    const elapsedSeconds = Math.floor(
      (performance.now() - state.quiz.startedAt) / 1000,
    );
    timer.textContent = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  };
  update();
  state.quiz.timerId = window.setInterval(update, 1000);
}

function stopQuizTimer() {
  if (state.quiz.timerId) window.clearInterval(state.quiz.timerId);
  state.quiz.timerId = null;
}

function emptyAlbumMarkup() {
  return `<div class="empty-state empty-album-state"><span>✦</span><h3>L'album aspetta il primo ricordo</h3><p>Hai scattato una foto? Caricala tu: comparira' nell'album condiviso per tutti gli invitati.</p><a class="btn btn-primary" href="album.html#upload">Carica le tue foto</a></div>`;
}

function showQuizResult(message) {
  const result = $("[data-quiz-result]");
  if (!result) return;

  result.classList.remove("hidden");
  result.innerHTML = `
    <p class="card-kicker">Risultato</p>
    <h3>${escapeHtml(message)}</h3>
  `;
}

function initAlbum() {
  initUpload();
  initDropzone();
  initUploadPreview();
  initGallerySearch();
  initGallerySelection();
  loadGallery();
}

function initGallerySelection() {
  $("[data-select-photos]")?.addEventListener("click", () => {
    state.gallery.selecting = !state.gallery.selecting;
    state.gallery.selected.clear();
    loadGallery(state.gallery.search, state.gallery.page);
  });
  $("[data-download-selected]")?.addEventListener(
    "click",
    downloadSelectedPhotos,
  );
}

function initDropzone() {
  const dropzone = $("[data-dropzone]");
  if (!dropzone) return;

  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("drag-over");
    });
  });

  dropzone.addEventListener("drop", (event) => {
    const input = $("input[type='file']", dropzone);
    if (input && event.dataTransfer?.files?.length) {
      input.files = event.dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}

function initUploadPreview() {
  const form = $("[data-upload-form]");
  const preview = $("[data-upload-preview]");
  const input = $("input[type='file']", form);
  if (!input || !preview) return;

  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    $$("img", preview).forEach((image) => URL.revokeObjectURL(image.src));
    if (!files.length) {
      preview.replaceChildren();
      return;
    }

    preview.innerHTML = files
      .slice(0, 6)
      .map((file) => {
        const url = URL.createObjectURL(file);
        return `<figure><img src="${escapeAttr(url)}" alt="Anteprima ${escapeAttr(file.name)}"><figcaption>${escapeHtml(file.name)}</figcaption></figure>`;
      })
      .join("");

    if (files.length > 6) {
      preview.insertAdjacentHTML(
        "beforeend",
        `<span class="preview-more">+${files.length - 6}</span>`,
      );
    }
  });
}

function initUpload() {
  const form = $("[data-upload-form]");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const status = $("[data-upload-status]");
    const formData = new FormData(form);
    const uploaderName = String(formData.get("uploaderName") || "").trim();
    const files = Array.from(form.photos.files || []);

    if (!uploaderName.includes(" ") || uploaderName.length < 5) {
      status.innerHTML = `<div class="upload-line">Inserisci nome e cognome completi.</div>`;
      return;
    }

    if (!files.length) {
      status.innerHTML = `<div class="upload-line">Seleziona almeno una foto.</div>`;
      return;
    }

    if (files.length > 10 || files.some((file) => file.size > 20 * 1024 * 1024)) {
      status.innerHTML = `<div class="upload-line">Puoi caricare al massimo 10 foto, fino a 20 MB ciascuna.</div>`;
      return;
    }

    status.innerHTML = "";
    let uploadedCount = 0;

    for (const [index, file] of files.entries()) {
      const line = document.createElement("div");
      line.className = "upload-line";
      line.textContent = `Compressione foto ${index + 1}/${files.length}...`;
      status.appendChild(line);

      try {
        const compressed = await compressImageToWebP(file, 1920, 0.8);
        line.textContent = `Upload ${file.name} (${formatBytes(compressed.size)})...`;

        const presign = await api("/api/photos/presign", {
          method: "POST",
          admin: false,
          body: {
            uploaderName,
            fileName: file.name,
            size: compressed.size,
            type: "image/webp",
          },
        });

        const uploadResponse = await fetch(presign.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "image/webp" },
          body: compressed,
        });

        if (!uploadResponse.ok) {
          throw new Error("Cloudflare R2 ha rifiutato il caricamento.");
        }

        await api("/api/photos/confirm", {
          method: "POST",
          admin: false,
          body: {
            key: presign.key,
            uploaderName,
            originalName: file.name.replace(/\.[^.]+$/, ".webp"),
            size: compressed.size,
          },
        });

        line.textContent = `Foto caricata: ${file.name}`;
        uploadedCount += 1;
      } catch (error) {
        line.textContent = `Errore su ${file.name}: ${error.message}`;
      }
    }

    form.reset();
    $("[data-upload-preview]")?.replaceChildren();
    await loadGallery();
    if (uploadedCount === files.length) {
      showSuccessDialog(
        "Foto caricate",
        `Hai condiviso ${uploadedCount} foto nell'album. Grazie per il ricordo!`,
      );
    }
  });
}

function showSuccessDialog(title, message) {
  const dialog = document.createElement("div");
  dialog.className = "success-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "success-dialog-title");
  dialog.innerHTML = `
    <div class="success-dialog-card">
      <img src="assets/couple-mark.png" alt="Gloria e Beniamino">
      <p class="eyebrow">Grazie</p>
      <h2 id="success-dialog-title">${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <button class="btn btn-primary" type="button" data-close-success-dialog>Va bene</button>
    </div>`;
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  $("[data-close-success-dialog]", dialog)?.addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
}

async function compressImageToWebP(file, maxSide = 1920, quality = 0.8) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Formato file non valido.");
  }

  const bitmap = await createImageBitmap(file).catch(async () => {
    const image = await loadImageFromFile(file);
    return image;
  });

  const width = bitmap.width;
  const height = bitmap.height;
  const ratio = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext("2d", { alpha: false });
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("Compressione non riuscita."));
        resolve(
          new File([blob], file.name.replace(/\.[^.]+$/, ".webp"), {
            type: "image/webp",
          }),
        );
      },
      "image/webp",
      quality,
    );
  });
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Impossibile leggere l’immagine."));
    };
    image.src = url;
  });
}

function initGallerySearch() {
  const search = $("[data-photo-search]");
  if (!search) return;

  let timeout;
  search.addEventListener("input", () => {
    clearTimeout(timeout);
    state.gallery.search = search.value;
    state.gallery.page = 1;
    state.gallery.selected.clear();
    timeout = setTimeout(() => loadGallery(search.value, 1), 250);
  });
}

async function loadGallery(
  search = state.gallery.search,
  page = state.gallery.page,
) {
  const gallery = $("[data-gallery]");
  if (!gallery) return;

  gallery.innerHTML = `<div class="empty-state"><p>Caricamento album...</p></div>`;

  try {
    state.gallery.search = search;
    state.gallery.page = page;
    const query = `?search=${encodeURIComponent(search)}&limit=5&page=${page}`;
    const data = await api(`/api/photos${query}`, { admin: false });
    const photos = data.photos || [];

    if (!photos.length) {
      gallery.innerHTML = `<div class="empty-state"><p>Nessuna foto trovata.</p></div>`;
      return;
    }

    gallery.innerHTML = photos
      .map(
        (photo) => `
        <article class="gallery-item">
          <img src="${escapeAttr(photo.url)}" alt="Foto caricata da ${escapeAttr(photo.uploaderName)}" loading="lazy">
          ${state.gallery.selecting ? `<label class="photo-select"><input type="checkbox" value="${escapeAttr(photo.key)}" ${state.gallery.selected.has(photo.key) ? "checked" : ""}> Seleziona</label>` : ""}
          <div class="gallery-caption">
            <span><strong>${escapeHtml(photo.uploaderName)}</strong><small>${formatDate(photo.createdAt)}</small></span>
            <a class="download-pill" href="${escapeAttr(photo.downloadUrl)}" target="_blank" rel="noreferrer">Scarica</a>
          </div>
        </article>
      `,
      )
      .join("");
    $$('[data-gallery] input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => {
        input.checked
          ? state.gallery.selected.add(input.value)
          : state.gallery.selected.delete(input.value);
        updateGallerySelectionControls();
      });
    });
    renderGalleryPagination(data.total, data.limit, data.page);
    updateGallerySelectionControls();
  } catch (error) {
    gallery.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function updateGallerySelectionControls() {
  const selectButton = $("[data-select-photos]");
  const downloadButton = $("[data-download-selected]");
  if (!selectButton || !downloadButton) return;
  selectButton.textContent = state.gallery.selecting
    ? "Annulla selezione"
    : "Seleziona foto";
  downloadButton.classList.toggle(
    "hidden",
    !state.gallery.selecting || !state.gallery.selected.size,
  );
  downloadButton.textContent = `Scarica selezionate (${state.gallery.selected.size})`;
}

function renderGalleryPagination(total, limit, currentPage) {
  const root = $("[data-gallery-pagination]");
  if (!root) return;
  const pages = Math.ceil(total / limit);
  root.innerHTML =
    pages > 1
      ? Array.from(
          { length: pages },
          (_, index) =>
            `<button class="${currentPage === index + 1 ? "active" : ""}" type="button" data-gallery-page="${index + 1}">${index + 1}</button>`,
        ).join("")
      : "";
  $$("[data-gallery-page]", root).forEach((button) =>
    button.addEventListener("click", () =>
      loadGallery(state.gallery.search, Number(button.dataset.galleryPage)),
    ),
  );
}

async function downloadSelectedPhotos() {
  const keys = Array.from(state.gallery.selected);
  if (!keys.length) return;
  try {
    const data = await api(
      `/api/photos?search=${encodeURIComponent(state.gallery.search)}&limit=200&page=1`,
      { admin: false },
    );
    data.photos
      .filter((photo) => keys.includes(photo.key))
      .forEach((photo, index) => {
        window.setTimeout(() => window.open(photo.downloadUrl, "_blank"), index * 500);
      });
  } catch (error) {
    alert(error.message);
  }
}

function initAdmin() {
  const login = $("[data-admin-login]");
  const panel = $("[data-admin-panel]");

  if (state.adminToken) {
    login?.classList.add("hidden");
    panel?.classList.remove("hidden");
    loadAdminAll();
  }

  $("[data-admin-login-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const status = $("[data-admin-login-status]");
    const credentials = Object.fromEntries(
      new FormData(event.currentTarget).entries(),
    );

    try {
      status.textContent = "Accesso in corso...";
      const data = await api("/api/admin/login", {
        method: "POST",
        admin: false,
        body: credentials,
      });

      state.adminToken = data.token;
      localStorage.setItem("gbAdminToken", data.token);
      login?.classList.add("hidden");
      panel?.classList.remove("hidden");
      await loadAdminAll();
    } catch (error) {
      status.textContent = error.message;
    }
  });

  $$(".tab-btn").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".tab-btn").forEach((item) => item.classList.remove("active"));
      $$(".admin-tab").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $(`[data-tab="${button.dataset.tabTarget}"]`)?.classList.add("active");
    });
  });

  $("[data-delete-selected]")?.addEventListener("click", deleteSelectedPhotos);
  $("[data-download-selected-admin]")?.addEventListener(
    "click",
    downloadSelectedAdminPhotos,
  );
  $("[data-quiz-editor]")?.addEventListener("submit", saveQuizQuestion);
  $("[data-reset-editor]")?.addEventListener("click", resetQuizEditor);
  $("[data-add-answer]")?.addEventListener("click", () => addAnswerField());
  $("[data-save-question-order]")?.addEventListener(
    "click",
    saveQuestionOrder,
  );
  $("[data-leaderboard-search]")?.addEventListener("input", (event) =>
    renderAdminLeaderboard(event.target.value, 1),
  );
  $("[data-admin-logout]")?.addEventListener("click", () => {
    localStorage.removeItem("gbAdminToken");
    state.adminToken = "";
    window.location.reload();
  });
  resetQuizEditor();

  window.setInterval(() => {
    if (state.adminToken && !panel?.classList.contains("hidden"))
      loadAdminAll(false);
  }, 10000);
}

async function loadAdminAll(showLoading = true) {
  await Promise.all([
    loadAdminDashboard(showLoading),
    loadAdminPhotos(showLoading),
    loadAdminMessages(showLoading, "guestbook"),
    loadAdminMessages(showLoading, "contact"),
    ...(state.adminQuestionOrderDirty ? [] : [loadAdminQuiz(showLoading)]),
  ]);
}

async function loadAdminDashboard() {
  const root = $("[data-admin-stats]");
  if (!root) return;

  try {
    const data = await api("/api/admin/dashboard");
    const stats = data.stats;

    root.innerHTML = `
      ${statCard(stats.photos, "Foto")}
      ${statCard(stats.messages, "Messaggi")}
      ${statCard(stats.unreadMessages, "Da leggere")}
      ${statCard(stats.quizQuestions, "Domande quiz")}
      ${statCard(stats.quizSubmissions, "Risposte quiz")}
    `;
  } catch (error) {
    handleAdminError(error);
  }
}

function statCard(value, label) {
  return `<article class="stat-card"><strong>${value}</strong><span>${escapeHtml(label)}</span></article>`;
}

async function loadAdminPhotos(showLoading = true) {
  const root = $("[data-admin-photos]");
  if (!root) return;
  if (showLoading)
    root.innerHTML = `<div class="empty-state"><p>Caricamento foto...</p></div>`;

  try {
    const data = await api("/api/admin/photos");
    const photos = data.photos || [];
    state.adminPhotos = photos;

    if (!photos.length) {
      root.innerHTML = `<div class="empty-state"><p>Nessuna foto caricata.</p></div>`;
      renderAdminPagination("photos", 0, () => loadAdminPhotos(false));
      return;
    }

    const pagePhotos = paginateAdminItems("photos", photos);
    root.innerHTML = pagePhotos
      .map(
        (photo) => `
        <article class="admin-photo-card">
          <img src="${escapeAttr(photo.url)}" alt="${escapeAttr(photo.uploaderName)}" loading="lazy">
          <label>
            <input type="checkbox" value="${escapeAttr(photo.key)}" data-photo-select>
            <span>${escapeHtml(photo.uploaderName)}<br><small>${formatDate(photo.createdAt)}</small></span>
          </label>
        </article>
      `,
      )
      .join("");
    renderAdminPagination("photos", photos.length, () => loadAdminPhotos(false));
  } catch (error) {
    handleAdminError(error);
  }
}

function downloadSelectedAdminPhotos() {
  const keys = $$('[data-admin-photos] [data-photo-select]:checked').map(
    (input) => input.value,
  );
  if (!keys.length) {
    alert("Seleziona almeno una foto.");
    return;
  }

  keys.forEach((key, index) => {
    const photo = state.adminPhotos.find((item) => item.key === key);
    if (!photo) return;
    window.setTimeout(() => window.open(photo.downloadUrl, "_blank"), index * 500);
  });
}

async function deleteSelectedPhotos() {
  const keys = $$("[data-photo-select]:checked").map((input) => input.value);
  if (!keys.length) {
    alert("Seleziona almeno una foto.");
    return;
  }

  if (!confirm(`Eliminare ${keys.length} foto? L'azione non è reversibile.`))
    return;

  try {
    await api("/api/admin/photos", {
      method: "DELETE",
      body: { keys },
    });
    await loadAdminAll();
  } catch (error) {
    alert(error.message);
  }
}

async function loadAdminMessages(showLoading = true, type = "guestbook") {
  const root = $(
    type === "contact" ? "[data-admin-contacts]" : "[data-admin-messages]",
  );
  if (!root) return;
  if (showLoading)
    root.innerHTML = `<div class="empty-state"><p>Caricamento messaggi...</p></div>`;

  try {
    const data = await api(`/api/admin/messages?type=${type}`);
    const messages = data.messages || [];
    const pageName = type === "contact" ? "contacts" : "messages";

    if (!messages.length) {
      root.innerHTML = `<div class="empty-state"><p>Nessun messaggio ricevuto.</p></div>`;
      renderAdminPagination(pageName, 0, () => loadAdminMessages(false, type));
      return;
    }

    const pageMessages = paginateAdminItems(pageName, messages);
    root.innerHTML = pageMessages
      .map(
        (message) => `
        <article class="message-item ${message.read ? "" : "unread"}">
          <p class="card-kicker">${message.read ? "Letto" : "Da leggere"}</p>
          <h3>${escapeHtml(message.name)}</h3>
          <p>${escapeHtml(message.message)}</p>
          <small>${escapeHtml(message.email || "Nessun contatto")} · ${formatDate(message.createdAt)}</small>
          <div class="editor-actions">
            <button class="btn btn-secondary" type="button" data-toggle-read="${escapeAttr(message.id)}" data-read="${message.read ? "false" : "true"}">
              ${message.read ? "Segna come da leggere" : "Segna come letto"}
            </button>
            <button class="btn btn-danger" type="button" data-delete-message="${escapeAttr(message.id)}">Elimina</button>
          </div>
        </article>
      `,
      )
      .join("");
    renderAdminPagination(pageName, messages.length, () =>
      loadAdminMessages(false, type),
    );

    $$("[data-toggle-read]").forEach((button) => {
      button.addEventListener("click", async () => {
        await api(`/api/admin/messages/${button.dataset.toggleRead}/read`, {
          method: "PATCH",
          body: { read: button.dataset.read === "true" },
        });
        await loadAdminMessages(false, type);
        await loadAdminDashboard();
      });
    });

    $$("[data-delete-message]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!confirm("Eliminare questo messaggio?")) return;
        await api(`/api/admin/messages/${button.dataset.deleteMessage}`, {
          method: "DELETE",
        });
        await loadAdminMessages(false, type);
        await loadAdminDashboard();
      });
    });
  } catch (error) {
    handleAdminError(error);
  }
}

async function loadAdminQuiz(showLoading = true) {
  const questionRoot = $("[data-admin-questions]");
  if (!questionRoot) return;

  if (showLoading) {
    questionRoot.innerHTML = `<div class="empty-state"><p>Caricamento quiz...</p></div>`;
  }

  try {
    const data = await api("/api/admin/quiz");
    const questions = data.questions || [];
    state.adminQuestions = questions;
    state.adminQuestionOrderDirty = false;
    state.adminLeaderboard = data.leaderboard || [];

    questionRoot.innerHTML = questions.length
      ? paginateAdminItems("questions", questions)
          .map(
            (question) => `
          <article class="question-card">
            <h3>${escapeHtml(question.question)}</h3>
            <ul>
              ${question.answers
                .map(
                  (answer, index) => `
                  <li class="${index === question.correctIndex ? "correct" : ""}">
                    ${escapeHtml(answer)} ${index === question.correctIndex ? "✓" : ""}
                  </li>
                `,
                )
                .join("")}
            </ul>
            <div class="editor-actions">
              <button class="btn btn-ghost" type="button" data-move-question="up" data-question-id="${escapeAttr(question.id)}">Sposta su</button>
              <button class="btn btn-ghost" type="button" data-move-question="down" data-question-id="${escapeAttr(question.id)}">Sposta giu</button>
              <button class="btn btn-secondary" type="button" data-edit-question='${escapeAttr(JSON.stringify(question))}'>Modifica</button>
              <button class="btn btn-danger" type="button" data-delete-question="${escapeAttr(question.id)}">Elimina</button>
            </div>
          </article>
        `,
          )
          .join("")
      : `<div class="empty-state"><p>Nessuna domanda creata.</p></div>`;

    renderAdminPagination("questions", questions.length, () => loadAdminQuiz(false));
    $("[data-save-question-order]")?.classList.add("hidden");

    renderAdminLeaderboard($("[data-leaderboard-search]")?.value || "");

    $$("[data-edit-question]").forEach((button) => {
      button.addEventListener("click", () => {
        const question = JSON.parse(button.dataset.editQuestion);
        fillQuizEditor(question);
      });
    });

    $$("[data-delete-question]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!confirm("Eliminare questa domanda?")) return;
        await api(
          `/api/admin/quiz/questions/${button.dataset.deleteQuestion}`,
          { method: "DELETE" },
        );
        await loadAdminAll(false);
      });
    });

    $$("[data-move-question]").forEach((button) => {
      button.addEventListener("click", () => {
        const index = state.adminQuestions.findIndex(
          (question) => question.id === button.dataset.questionId,
        );
        const target = button.dataset.moveQuestion === "up" ? index - 1 : index + 1;
        if (index < 0 || target < 0 || target >= state.adminQuestions.length) return;
        const currentPageStart = (state.adminPages.questions - 1) * 10;
        const currentPageEnd = currentPageStart + 10;
        if (target < currentPageStart || target >= currentPageEnd) {
          alert("Salva l'ordine e passa alla pagina successiva per spostare questa domanda.");
          return;
        }
        [state.adminQuestions[index], state.adminQuestions[target]] = [
          state.adminQuestions[target],
          state.adminQuestions[index],
        ];
        state.adminQuestionOrderDirty = true;
        $("[data-save-question-order]")?.classList.remove("hidden");
        renderAdminQuestionOrder();
      });
    });
  } catch (error) {
    handleAdminError(error);
  }
}

function renderAdminQuestionOrder() {
  const root = $("[data-admin-questions]");
  if (!root) return;
  const cards = new Map(
    $$('[data-question-id]', root).map((button) => [
      button.dataset.questionId,
      button.closest(".question-card"),
    ]),
  );
  state.adminQuestions
    .slice((state.adminPages.questions - 1) * 10, state.adminPages.questions * 10)
    .forEach((question) => root.append(cards.get(question.id)));
}

async function saveQuestionOrder() {
  try {
    await api("/api/admin/quiz/questions/order", {
      method: "PUT",
      body: { ids: state.adminQuestions.map((question) => question.id) },
    });
    state.adminQuestionOrderDirty = false;
    await loadAdminQuiz(false);
  } catch (error) {
    alert(error.message);
  }
}

function renderAdminLeaderboard(search = "", page = state.adminPages.leaderboard) {
  const root = $("[data-admin-leaderboard]");
  if (!root) return;

  const query = search.trim().toLowerCase();
  const rows = state.adminLeaderboard.filter((row) =>
    `${row.name} ${row.surname}`.toLowerCase().includes(query),
  );
  state.adminPages.leaderboard = page;
  const pageRows = paginateAdminItems("leaderboard", rows);

  root.innerHTML = rows.length
    ? pageRows
        .map(
          (row) => `
          <li>
            <span class="rank">${row.position}</span>
            <span><strong>${escapeHtml(row.name)} ${escapeHtml(row.surname)}</strong><small>${row.correctAnswers}/${row.total} risposte corrette · Tempo ${formatElapsed(row.elapsedMs)}</small></span>
            <span class="score">${formatElapsed(row.elapsedMs)}</span>
            <button class="remove-submission" type="button" data-delete-submission="${escapeAttr(row.id)}" aria-label="Elimina ${escapeAttr(row.name)} ${escapeAttr(row.surname)}">×</button>
          </li>
        `,
        )
        .join("")
    : `<li class="empty-line">Nessun invitato trovato.</li>`;

  renderAdminPagination("leaderboard", rows.length, () =>
    renderAdminLeaderboard(search),
  );

  $$("[data-delete-submission]", root).forEach((button) => {
    button.addEventListener("click", async () => {
      if (
        !confirm(
          "Eliminare questo partecipante dalla classifica? Potrà rifare il quiz.",
        )
      )
        return;
      await api(
        `/api/admin/quiz/submissions/${button.dataset.deleteSubmission}`,
        { method: "DELETE" },
      );
      await loadAdminAll(false);
    });
  });
}

async function saveQuizQuestion(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const status = $("[data-quiz-editor-status]");
  const id = $("[name='id']", form).value;
  const formData = new FormData(form);
  const answers = $$("[data-answer-field]", form)
    .map((input) => input.value.trim())
    .filter(Boolean);

  const payload = {
    question: String(new FormData(form).get("question") || "").trim(),
    answers,
    correctIndex: Number(formData.get("correctIndex")),
  };

  try {
    status.textContent = "Salvataggio...";
    await api(
      id ? `/api/admin/quiz/questions/${id}` : "/api/admin/quiz/questions",
      {
        method: id ? "PUT" : "POST",
        body: payload,
      },
    );
    resetQuizEditor();
    status.textContent = "Domanda salvata.";
    await loadAdminAll(false);
  } catch (error) {
    status.textContent = error.message;
  }
}

function fillQuizEditor(question) {
  const form = $("[data-quiz-editor]");
  if (!form) return;

  $("[name='id']", form).value = question.id;
  form.question.value = question.question;
  const fields = $("[data-answer-fields]", form);
  fields.innerHTML = "";
  question.answers.forEach((answer) => addAnswerField(answer));
  syncCorrectAnswerOptions(question.correctIndex);
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetQuizEditor() {
  const form = $("[data-quiz-editor]");
  if (!form) return;
  form.reset();
  $("[name='id']", form).value = "";
  const fields = $("[data-answer-fields]", form);
  fields.innerHTML = "";
  addAnswerField();
  addAnswerField();
  syncCorrectAnswerOptions();
}

function addAnswerField(value = "") {
  const fields = $("[data-answer-fields]");
  if (!fields || fields.children.length >= 6) return;
  const row = document.createElement("div");
  row.className = "answer-input-row";
  row.innerHTML = `<input type="text" data-answer-field value="${escapeAttr(value)}" placeholder="Risposta ${fields.children.length + 1}" required><button class="remove-answer" type="button" aria-label="Rimuovi risposta">×</button>`;
  fields.appendChild(row);
  $("[data-answer-field]", row).addEventListener("input", () =>
    syncCorrectAnswerOptions(),
  );
  $(".remove-answer", row).addEventListener("click", () => {
    if (fields.children.length <= 2) return;
    row.remove();
    syncCorrectAnswerOptions();
  });
  syncCorrectAnswerOptions();
}

function syncCorrectAnswerOptions(selectedIndex = undefined) {
  const select = $("[data-correct-answer]");
  const answers = $$("[data-answer-field]").map((input) => input.value.trim());
  const current = selectedIndex ?? Number(select?.value || 0);
  if (!select) return;
  select.innerHTML = answers
    .map(
      (answer, index) =>
        `<option value="${index}">Risposta ${index + 1}${answer ? `: ${escapeHtml(answer)}` : ""}</option>`,
    )
    .join("");
  select.value = Math.min(current, Math.max(answers.length - 1, 0));
}

function handleAdminError(error) {
  if (error.message.toLowerCase().includes("non autorizzato")) {
    localStorage.removeItem("gbAdminToken");
    state.adminToken = "";
    window.location.reload();
    return;
  }
  console.error(error);
}

function paginateAdminItems(name, items, limit = 10) {
  const pages = Math.max(1, Math.ceil(items.length / limit));
  state.adminPages[name] = Math.min(Math.max(state.adminPages[name] || 1, 1), pages);
  const start = (state.adminPages[name] - 1) * limit;
  return items.slice(start, start + limit);
}

function renderAdminPagination(name, total, onChange, limit = 10) {
  const root = $(`[data-admin-${name}-pagination]`);
  if (!root) return;
  const pages = Math.ceil(total / limit);
  root.innerHTML =
    pages > 1
      ? Array.from(
          { length: pages },
          (_, index) =>
            `<button class="${state.adminPages[name] === index + 1 ? "active" : ""}" type="button" data-admin-page="${index + 1}">${index + 1}</button>`,
        ).join("")
      : "";
  $$('[data-admin-page]', root).forEach((button) =>
    button.addEventListener("click", () => {
      state.adminPages[name] = Number(button.dataset.adminPage);
      onChange();
    }),
  );
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatElapsed(milliseconds) {
  const seconds = Math.floor(Number(milliseconds || 0) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("it-IT", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

