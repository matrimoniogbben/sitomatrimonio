const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const page = document.body.dataset.page;

const state = {
  quiz: {
    participant: null,
    questions: [],
    current: 0,
    answers: [],
    startedAt: 0,
    timerId: null,
  },
  adminToken: localStorage.getItem("gbAdminToken") || "",
};

document.addEventListener("DOMContentLoaded", () => {
  document.body.classList.add("loaded");

  initNavigation();
  initRevealAnimations();
  initMapFrames();

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

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  items.forEach((item) => observer.observe(item));
}

function initMapFrames() {
  $$("[data-map-query]").forEach((frame) => {
    const query = encodeURIComponent(frame.dataset.mapQuery || "Gloria Beniamino matrimonio");
    const iframe = $("iframe", frame);
    if (iframe) {
      iframe.src = `https://maps.google.com/maps?q=${query}&t=&z=14&ie=UTF8&iwloc=&output=embed`;
    }
  });
}

async function api(path, options = {}) {
  const headers = {
    ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {}),
  };

  if (options.admin !== false && state.adminToken) {
    headers.Authorization = `Bearer ${state.adminToken}`;
  }

  const response = await fetch(path, {
    ...options,
    headers,
    body:
      options.body && !(options.body instanceof FormData) && typeof options.body !== "string"
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

  window.setInterval(loadPhotoCarousel, 20000);
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
          <span class="photo-badge">${escapeHtml(photo.uploaderName)}</span>
        </article>
      `
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
    const data = Object.fromEntries(new FormData(form).entries());

    try {
      status.textContent = "Invio in corso...";
      await api("/api/messages", {
        method: "POST",
        body: data,
        admin: false,
      });
      form.reset();
      status.textContent = "Messaggio inviato. Grazie!";
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
    form.insertAdjacentHTML("afterend", `<p class="form-note">${escapeHtml(error.message)}</p>`);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const participant = Object.fromEntries(new FormData(form).entries());
    state.quiz.participant = {
      name: participant.name.trim(),
      surname: participant.surname.trim(),
      email: participant.email.trim(),
    };
    state.quiz.current = 0;
    state.quiz.answers = new Array(state.quiz.questions.length).fill(null);
    state.quiz.startedAt = performance.now();

    if (!state.quiz.questions.length) {
      showQuizResult("Il quiz non ha ancora domande. Riprova più tardi.");
      return;
    }

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
}

function renderQuizQuestion() {
  const question = state.quiz.questions[state.quiz.current];
  const total = state.quiz.questions.length;

  $("[data-quiz-counter]").textContent = `Domanda ${state.quiz.current + 1} di ${total}`;
  $("[data-quiz-progress]").style.width = `${((state.quiz.current + 1) / total) * 100}%`;
  $("[data-quiz-intro]").textContent = question.intro || "";
  $("[data-quiz-question]").textContent = question.question;

  const answersRoot = $("[data-quiz-answers]");
  answersRoot.innerHTML = question.answers
    .map(
      (answer, index) => `
      <button class="answer-option ${state.quiz.answers[state.quiz.current] === index ? "selected" : ""}" type="button" data-answer-index="${index}">
        ${escapeHtml(answer)}
      </button>
    `
    )
    .join("");

  $$("[data-answer-index]", answersRoot).forEach((button) => {
    button.addEventListener("click", () => {
      state.quiz.answers[state.quiz.current] = Number(button.dataset.answerIndex);
      renderQuizQuestion();
    });
  });

  $("[data-quiz-prev]").disabled = state.quiz.current === 0;
  $("[data-quiz-next]").textContent = state.quiz.current === total - 1 ? "Invia risposte" : "Avanti";
}

async function submitQuiz() {
  stopQuizTimer();
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
    showQuizResult(`Hai risposto correttamente a ${result.correctAnswers}/${result.total} domande.`);
  } catch (error) {
    showQuizResult(error.message);
  }
}

function startQuizTimer() {
  stopQuizTimer();
  const timer = $("[data-quiz-timer]");
  const update = () => {
    const elapsedSeconds = Math.floor((performance.now() - state.quiz.startedAt) / 1000);
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
  return `<div class="empty-state empty-album-state"><span>✦</span><h3>L'album aspetta il primo ricordo</h3><p>Scatta, scegli e carica: le tue foto compariranno qui per tutti gli invitati.</p><a class="btn btn-primary" href="album.html#upload">Carica una foto</a></div>`;
}

function showQuizResult(message) {
  const result = $("[data-quiz-result]");
  if (!result) return;

  result.classList.remove("hidden");
  result.innerHTML = `
    <p class="card-kicker">Risultato</p>
    <h3>${escapeHtml(message)}</h3>
    <button class="btn btn-secondary" type="button" data-restart-quiz>Rigioca</button>
  `;

  $("[data-restart-quiz]")?.addEventListener("click", () => {
    window.location.reload();
  });
}

function initAlbum() {
  initUpload();
  initDropzone();
  initGallerySearch();
  loadGallery();
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
    if (input && event.dataTransfer?.files?.length) input.files = event.dataTransfer.files;
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

    status.innerHTML = "";

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
      } catch (error) {
        line.textContent = `Errore su ${file.name}: ${error.message}`;
      }
    }

    form.reset();
    await loadGallery();
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
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".webp"), { type: "image/webp" }));
      },
      "image/webp",
      quality
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
    timeout = setTimeout(() => loadGallery(search.value), 250);
  });
}

async function loadGallery(search = "") {
  const gallery = $("[data-gallery]");
  if (!gallery) return;

  gallery.innerHTML = `<div class="empty-state"><p>Caricamento album...</p></div>`;

  try {
    const query = search ? `?search=${encodeURIComponent(search)}&limit=200` : "?limit=200";
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
          <div class="gallery-caption">
            <span>${escapeHtml(photo.uploaderName)}</span>
            <a class="download-pill" href="${escapeAttr(photo.downloadUrl)}" target="_blank" rel="noreferrer">Scarica</a>
          </div>
        </article>
      `
      )
      .join("");
  } catch (error) {
    gallery.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
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
    const credentials = Object.fromEntries(new FormData(event.currentTarget).entries());

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
  $("[data-quiz-editor]")?.addEventListener("submit", saveQuizQuestion);
  $("[data-reset-editor]")?.addEventListener("click", resetQuizEditor);

  window.setInterval(() => {
    if (state.adminToken && !panel?.classList.contains("hidden")) loadAdminAll(false);
  }, 10000);
}

async function loadAdminAll(showLoading = true) {
  await Promise.all([
    loadAdminDashboard(showLoading),
    loadAdminPhotos(showLoading),
    loadAdminMessages(showLoading),
    loadAdminQuiz(showLoading),
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
  if (showLoading) root.innerHTML = `<div class="empty-state"><p>Caricamento foto...</p></div>`;

  try {
    const data = await api("/api/admin/photos");
    const photos = data.photos || [];

    if (!photos.length) {
      root.innerHTML = `<div class="empty-state"><p>Nessuna foto caricata.</p></div>`;
      return;
    }

    root.innerHTML = photos
      .map(
        (photo) => `
        <article class="admin-photo-card">
          <img src="${escapeAttr(photo.url)}" alt="${escapeAttr(photo.uploaderName)}" loading="lazy">
          <label>
            <input type="checkbox" value="${escapeAttr(photo.key)}" data-photo-select>
            <span>${escapeHtml(photo.uploaderName)}<br><small>${formatDate(photo.createdAt)}</small></span>
          </label>
        </article>
      `
      )
      .join("");
  } catch (error) {
    handleAdminError(error);
  }
}

async function deleteSelectedPhotos() {
  const keys = $$("[data-photo-select]:checked").map((input) => input.value);
  if (!keys.length) {
    alert("Seleziona almeno una foto.");
    return;
  }

  if (!confirm(`Eliminare ${keys.length} foto? L'azione non è reversibile.`)) return;

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

async function loadAdminMessages(showLoading = true) {
  const root = $("[data-admin-messages]");
  if (!root) return;
  if (showLoading) root.innerHTML = `<div class="empty-state"><p>Caricamento messaggi...</p></div>`;

  try {
    const data = await api("/api/admin/messages");
    const messages = data.messages || [];

    if (!messages.length) {
      root.innerHTML = `<div class="empty-state"><p>Nessun messaggio ricevuto.</p></div>`;
      return;
    }

    root.innerHTML = messages
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
          </div>
        </article>
      `
      )
      .join("");

    $$("[data-toggle-read]").forEach((button) => {
      button.addEventListener("click", async () => {
        await api(`/api/admin/messages/${button.dataset.toggleRead}/read`, {
          method: "PATCH",
          body: { read: button.dataset.read === "true" },
        });
        await loadAdminMessages(false);
        await loadAdminDashboard();
      });
    });
  } catch (error) {
    handleAdminError(error);
  }
}

async function loadAdminQuiz(showLoading = true) {
  const questionRoot = $("[data-admin-questions]");
  const leaderboardRoot = $("[data-admin-leaderboard]");
  if (!questionRoot || !leaderboardRoot) return;

  if (showLoading) {
    questionRoot.innerHTML = `<div class="empty-state"><p>Caricamento quiz...</p></div>`;
  }

  try {
    const data = await api("/api/admin/quiz");
    const questions = data.questions || [];
    const leaderboard = data.leaderboard || [];

    questionRoot.innerHTML = questions.length
      ? questions
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
                `
                )
                .join("")}
            </ul>
            <div class="editor-actions">
              <button class="btn btn-secondary" type="button" data-edit-question='${escapeAttr(JSON.stringify(question))}'>Modifica</button>
              <button class="btn btn-danger" type="button" data-delete-question="${escapeAttr(question.id)}">Elimina</button>
            </div>
          </article>
        `
          )
          .join("")
      : `<div class="empty-state"><p>Nessuna domanda creata.</p></div>`;

    leaderboardRoot.innerHTML = leaderboard.length
      ? leaderboard
          .slice(0, 20)
          .map(
            (row) => `
          <li>
            <span class="rank">${row.position}</span>
            <span>${escapeHtml(row.name)} ${escapeHtml(row.surname)}</span>
            <span class="score">${row.score} pt</span>
          </li>
        `
          )
          .join("")
      : `<li class="empty-line">Nessun risultato.</li>`;

    $$("[data-edit-question]").forEach((button) => {
      button.addEventListener("click", () => {
        const question = JSON.parse(button.dataset.editQuestion);
        fillQuizEditor(question);
      });
    });

    $$("[data-delete-question]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!confirm("Eliminare questa domanda?")) return;
        await api(`/api/admin/quiz/questions/${button.dataset.deleteQuestion}`, { method: "DELETE" });
        await loadAdminAll(false);
      });
    });
  } catch (error) {
    handleAdminError(error);
  }
}

async function saveQuizQuestion(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const status = $("[data-quiz-editor-status]");
  const formData = new FormData(form);
  const id = formData.get("id");

  const answers = [
    formData.get("answer0"),
    formData.get("answer1"),
    formData.get("answer2"),
    formData.get("answer3"),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const payload = {
    question: String(formData.get("question") || "").trim(),
    answers,
    correctIndex: Number(formData.get("correctIndex")),
  };

  try {
    status.textContent = "Salvataggio...";
    await api(id ? `/api/admin/quiz/questions/${id}` : "/api/admin/quiz/questions", {
      method: id ? "PUT" : "POST",
      body: payload,
    });
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

  form.id.value = question.id;
  form.question.value = question.question;
  form.answer0.value = question.answers[0] || "";
  form.answer1.value = question.answers[1] || "";
  form.answer2.value = question.answers[2] || "";
  form.answer3.value = question.answers[3] || "";
  form.correctIndex.value = question.correctIndex;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetQuizEditor() {
  const form = $("[data-quiz-editor]");
  if (!form) return;
  form.reset();
  form.id.value = "";
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

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
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
