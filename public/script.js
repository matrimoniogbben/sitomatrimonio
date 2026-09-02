const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) =>
  Array.from(root.querySelectorAll(selector));

const page = document.body.dataset.page;
const apiBaseUrl = String(window.APP_CONFIG?.apiBaseUrl || "").replace(
  /\/+$/,
  "",
);
const apiUrl = (path) => /^https?:\/\//i.test(path) ? path : `${apiBaseUrl}${path}`;

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
  gallery: { page: 1, search: "", date: "", time: "", selecting: false, selected: new Set(), items: [] },
  upload: { files: [], previewUrls: [], previewIndex: 0, uploading: false },
};

document.addEventListener("DOMContentLoaded", () => {
  document.body.classList.add("loaded");

  initNavigation();
  initRevealAnimations();
  initMapFrames();
  initDecorativeHearts();
  initLightbox();

  if (page === "home") initHome();
  if (page === "album") initAlbum();
  if (page === "admin") initAdmin();

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-download]");
    if (!button) return;
    event.preventDefault();
    triggerDownload(button.dataset.download, button.dataset.filename);
  });
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

/**
 * Funzione API con retry automatico e timeout esteso per gestire Cold Start su Render.
 * Implementa backoff esponenziale per errori temporanei (503, 504, network errors).
 */
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

  // Config per retry: max 3 tentativi, backoff esponenziale
  const maxRetries = 3;
  const baseDelay = 1000; // 1 secondo
  const timeoutMs = 20000; // 20 secondi di timeout per ogni tentativo

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(apiUrl(path), {
        ...options,
        headers,
        body:
          options.body &&
          !(options.body instanceof FormData) &&
          typeof options.body !== "string"
            ? JSON.stringify(options.body)
            : options.body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Gestisci errori HTTP temporanei (503 Service Unavailable, 504 Gateway Timeout)
      if (response.status === 503 || response.status === 504) {
        throw new Error(`Server temporaneamente non disponibile (${response.status})`);
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.message || "Operazione non riuscita.");
      }

      return data;
    } catch (error) {
      lastError = error;

      // Se è l'ultimo tentativo, lancia l'errore
      if (attempt >= maxRetries) {
        break;
      }

      // Retry solo per errori di rete o errori temporanei del server
      const isRetryable =
        error.name === "AbortError" ||
        error.name === "TypeError" || // Network error
        error.message.includes("503") ||
        error.message.includes("504") ||
        error.message.includes("network") ||
        error.message.includes("fetch");

      if (!isRetryable) {
        // Errore non ritentabile (es. 400, 401, 404)
        throw error;
      }

      // Backoff esponenziale: 1s, 2s, 4s + jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Tutti i tentativi falliti
  throw new Error(
    `Connessione al server non riuscita dopo ${maxRetries + 1} tentativi. ` +
    `Il sito potrebbe essere in fase di avvio. Riprova tra pochi secondi.` +
    (lastError?.message ? ` (${lastError.message})` : "")
  );
}

function initHome() {
  loadPhotoCarousel();
  // initCarouselControls viene chiamato dopo il caricamento delle foto
  const countdownActive = initQuizCountdown();
  if (!countdownActive) {
    initQuiz();
  }
  initMessageForm();

  window.setInterval(() => {
    if (!document.hidden) loadPhotoCarousel();
  }, 60000);
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Carica il carosello foto in Homepage con skeleton UI durante il caricamento.
 * Mostra "Album senza foto" SOLO se la chiamata ha successo e l'array è vuoto.
 */
async function loadPhotoCarousel() {
  const carousel = $("[data-photo-carousel]");
  if (!carousel) return;

  // Mostra skeleton loader elegante stile soft luxury
  carousel.innerHTML = `
    <div class="carousel-skeleton">
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
    </div>
  `;

  try {
    const data = await api("/api/photos?limit=20", { admin: false });
    let photos = data.photos || [];

    // Mostra messaggio "senza foto" SOLO se la chiamata ha successo (status 200) 
    // e l'array restituito è effettivamente vuoto
    if (!photos.length) {
      carousel.innerHTML = emptyAlbumMarkup();
      carousel.closest(".carousel-shell")?.classList.add("is-empty");
      return;
    }

    shuffleArray(photos);
    // Già limitato a 20 dall'API, ma per sicurezza tagliamo comunque
    photos = photos.slice(0, 20);

    carousel.closest(".carousel-shell")?.classList.remove("is-empty");
    carousel.innerHTML = photos
      .map(
        (photo) => `
        <article class="carousel-card">
          <img src="${escapeAttr(photo.url)}" alt="Foto caricata da ${escapeAttr(photo.uploaderName)}" loading="lazy">
          <div class="photo-badge"><strong>${escapeHtml(photo.uploaderName)}</strong><small>${formatDate(photo.createdAt)}</small></div>
        </article>
      `,
      )
      .join("");
    
    // Inizializza i controlli del carosello dopo il caricamento delle foto
    initCarouselControls();
  } catch (error) {
    // Mantiene lo skeleton o mostra errore solo se persistente
    // Non mostrare "Album senza foto" qui - quello è solo per array vuoto dopo successo
    console.warn("Caricamento carosello fallito:", error.message);
    carousel.innerHTML = `
      <div class="empty-state">
        <p>⚠️ ${escapeHtml(error.message)}</p>
        <button type="button" onclick="loadPhotoCarousel()" class="btn-retry">Riprova</button>
      </div>
    `;
  }
}

function initCarouselControls() {
  const carousel = $("[data-photo-carousel]");
  if (!carousel) return;

  const prevBtn = $("[data-carousel-prev]");
  const nextBtn = $("[data-carousel-next]");
  
  // Auto-scroll: avanza automaticamente ogni 3.5 secondi
  let autoScrollInterval = null;
  const startAutoScroll = () => {
    if (autoScrollInterval) clearInterval(autoScrollInterval);
    autoScrollInterval = setInterval(() => {
      const cards = carousel.querySelectorAll(".carousel-card");
      if (cards.length === 0) return;
      
      const maxScroll = carousel.scrollWidth - carousel.clientWidth;
      const scrollPos = carousel.scrollLeft;
      const atEnd = scrollPos >= maxScroll - 10;
      
      if (atEnd) {
        carousel.scrollTo({ left: 0, behavior: "smooth" });
      } else {
        carousel.scrollBy({ left: 220, behavior: "smooth" });
      }
    }, 3500);
  };
  
  const stopAutoScroll = () => {
    if (autoScrollInterval) clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  };
  
  // Avvia auto-scroll
  startAutoScroll();
  
  // Ferma auto-scroll quando l'utente interagisce
  carousel.addEventListener("scroll", () => {
    stopAutoScroll();
    startAutoScroll();
  });
  
  prevBtn?.addEventListener("click", () => {
    stopAutoScroll();
    startAutoScroll();
    
    const cards = carousel.querySelectorAll(".carousel-card");
    if (cards.length === 0) return;
    
    const cardWidth = cards[0].getBoundingClientRect().width + parseFloat(getComputedStyle(carousel).gap);
    const scrollPos = carousel.scrollLeft;
    const firstCardVisible = scrollPos < cardWidth * 0.5;
    
    if (firstCardVisible) {
      // Infinite loop: go to last card
      carousel.scrollTo({ left: carousel.scrollWidth, behavior: "smooth" });
    } else {
      carousel.scrollBy({ left: -220, behavior: "smooth" });
    }
  });

  nextBtn?.addEventListener("click", () => {
    stopAutoScroll();
    startAutoScroll();
    
    const cards = carousel.querySelectorAll(".carousel-card");
    if (cards.length === 0) return;
    
    const maxScroll = carousel.scrollWidth - carousel.clientWidth;
    const scrollPos = carousel.scrollLeft;
    const atEnd = scrollPos >= maxScroll - 10;
    
    if (atEnd) {
      // Infinite loop: go to first card
      carousel.scrollTo({ left: 0, behavior: "smooth" });
    } else {
      carousel.scrollBy({ left: 220, behavior: "smooth" });
    }
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


function initQuizCountdown() {
  const countdownRoot = $("[data-quiz-countdown]");
  const form = $("[data-quiz-start-form]");
  if (!countdownRoot || !form) return false;

  const target = new Date("2026-09-05T00:00:00+02:00");

  const update = () => {
    const now = new Date();
    const diff = target - now;

    if (diff <= 0) {
      countdownRoot.hidden = true;
      form.hidden = false;
      return true;
    }

    countdownRoot.hidden = false;
    form.hidden = true;

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const timerEl = $("[data-countdown-timer]", countdownRoot);
    if (timerEl) {
      timerEl.innerHTML = `
        <div class="countdown-unit"><strong>${days}</strong><span>giorni</span></div>
        <div class="countdown-sep">:</div>
        <div class="countdown-unit"><strong>${String(hours).padStart(2, "0")}</strong><span>ore</span></div>
        <div class="countdown-sep">:</div>
        <div class="countdown-unit"><strong>${String(minutes).padStart(2, "0")}</strong><span>minuti</span></div>
        <div class="countdown-sep">:</div>
        <div class="countdown-unit"><strong>${String(seconds).padStart(2, "0")}</strong><span>secondi</span></div>
      `;
    }

    return false;
  };

  const expired = update();
  if (expired) return false;

  const intervalId = window.setInterval(() => {
    if (update()) {
      window.clearInterval(intervalId);
      initQuiz();
    }
  }, 1000);

  return true;
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

  const nameInput = $("[name='name']", form);
  const surnameInput = $("[name='surname']", form);
  let identityCheckId = 0;
  const checkParticipation = async () => {
    const name = nameInput?.value.trim() || "";
    const startAlert = $("[data-quiz-start-alert]");
    const checkId = ++identityCheckId;

    if (!name) {
      startAlert?.classList.add("hidden");
      return false;
    }

    try {
      const check = await api(
        `/api/quiz/participation?name=${encodeURIComponent(name)}`,
        { admin: false },
      );
      if (checkId !== identityCheckId) return false;
      if (check.participated) {
        startAlert?.classList.remove("hidden");
        $("h3", startAlert).textContent =
          "Hai già partecipato al quiz con questo nome/nickname.";
        return true;
      }
      startAlert?.classList.add("hidden");
    } catch {
      if (checkId === identityCheckId) startAlert?.classList.add("hidden");
    }
    return false;
  };

  [nameInput].forEach((input) => {
    input?.addEventListener("input", checkParticipation);
    input?.addEventListener("change", checkParticipation);
    input?.addEventListener("blur", checkParticipation);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const participant = Object.fromEntries(new FormData(form).entries());
    state.quiz.participant = {
      name: participant.name.trim(),
    };
    state.quiz.current = 0;
    state.quiz.answers = new Array(state.quiz.questions.length).fill(null);

    if (!state.quiz.questions.length) {
      showQuizResult("Il quiz non ha ancora domande. Riprova più tardi.");
      return;
    }

    const startAlert = $("[data-quiz-start-alert]");
    if (await checkParticipation()) return;


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
    event.returnValue = " ";
    try {
      sessionStorage.setItem("quizAbandoned", "true");
      if (state.quiz.participant) {
        sessionStorage.setItem("quizParticipant", JSON.stringify(state.quiz.participant));
      }
    } catch {}
  });

  document.addEventListener("keydown", (event) => {
    if (!state.quiz.inProgress) return;
    if (event.key === "F5" || (event.ctrlKey && event.key === "r") || (event.metaKey && event.key === "r")) {
      event.preventDefault();
      const total = state.quiz.questions.length;
      const dialog = document.createElement("div");
      dialog.className = "success-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.innerHTML = `
        <div class="success-dialog-card">
          <img src="assets/couple-mark.png" alt="Gloria e Beniamino">
          <p class="eyebrow">Attenzione</p>
          <h2>Stai per ricaricare la pagina</h2>
          <p>Se ricarichi ora il quiz verrà segnato come 0/${total} e non potrai rifarlo. Vuoi continuare?</p>
          <div class="gallery-actions" style="justify-content:center;margin-top:1.2rem">
            <button class="btn btn-primary" type="button" data-confirm-reload>Ricarica</button>
            <button class="btn btn-secondary" type="button" data-cancel-reload>Resta</button>
          </div>
        </div>`;
      document.body.appendChild(dialog);
      const close = () => dialog.remove();
      $("[data-cancel-reload]", dialog)?.addEventListener("click", close);
      $("[data-confirm-reload]", dialog)?.addEventListener("click", () => {
        close();
        const payload = JSON.stringify(state.quiz.participant);
        fetch(`${apiBaseUrl}/api/quiz/abandon`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: payload, keepalive: true }).catch(() => {});
        try {
          sessionStorage.setItem("quizAbandoned", "true");
          if (state.quiz.participant) {
            sessionStorage.setItem("quizParticipant", JSON.stringify(state.quiz.participant));
          }
        } catch {}
        window.location.reload();
      });
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) close();
      });
    }
  });

  window.addEventListener("pagehide", () => {
    if (!state.quiz.inProgress || !state.quiz.participant) return;
    const payload = JSON.stringify(state.quiz.participant);
    navigator.sendBeacon(
      `${apiBaseUrl}/api/quiz/abandon`,
      new Blob([payload], { type: "text/plain" }),
    );
  });

  checkQuizAbandonedOnReload();
  initQuizNavigationGuard();
}

function initLightbox() {
  // Delega click su tutte le immagini galleria/carousel/admin
  document.body.addEventListener("click", (e) => {
    const img = e.target.closest(
      "[data-gallery] img, [data-photo-carousel] img, [data-admin-photos] img",
    );
    if (!img) return;

    // Non aprire lightbox se click su checkbox/select/button
    if (e.target.matches("input, button, label, .download-pill")) return;

    // Raccogli tutte le immagini del contenitore per navigazione
    const container = img.closest("[data-gallery], [data-photo-carousel], [data-admin-photos]");
    if (container) {
      const allImgs = Array.from(container.querySelectorAll("img"));
      lightboxState.images = allImgs.map(i => i.src);
      lightboxState.currentIndex = allImgs.indexOf(img);
    }

    openLightbox(img.src, img.alt);
  }, { passive: true });

  // Crea lightbox DOM se non esiste
  if (!document.getElementById("lightbox")) createLightboxDOM();
  const lightbox = document.getElementById("lightbox");
  if (!lightbox) return;

  // CHIUSURA via bottone X
  const closeBtn = lightbox.querySelector(".lightbox__close");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeLightbox);
  }

  // CHIUSURA click overlay (solo se click sul contenitore principale, non sull'immagine)
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });

  // CHIUSURA via tasto ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lightbox.classList.contains("open")) {
      closeLightbox();
    }
  });
}

let lightboxState = {
  currentIndex: -1,
  images: [],
};

function createLightboxDOM() {
  const lb = document.createElement("div");
  lb.id = "lightbox";
  lb.className = "lightbox";
  lb.setAttribute("role", "dialog");
  lb.setAttribute("aria-modal", "true");
  lb.setAttribute("aria-label", "Visualizzazione immagine a schermo intero");
  lb.innerHTML = `
    <div class="lightbox__container">
      <div class="lightbox__loader" aria-hidden="true"></div>
      <img class="lightbox__image" src="" alt="" />
      <button class="lightbox__close" aria-label="Chiudi" type="button">&times;</button>
      <button class="lightbox__nav prev" aria-label="Precedente" type="button">&#8249;</button>
      <button class="lightbox__nav next" aria-label="Successiva" type="button">&#8250;</button>
      <div class="lightbox__hint" aria-hidden="true">
        Tocca due volte per zoomare
      </div>
    </div>`;
  document.body.appendChild(lb);
  
  const img = lb.querySelector(".lightbox__image");
  setupZoom(img);
  setupLightboxNavigation(lb);
}

function setupLightboxNavigation(lightbox) {
  const prevBtn = lightbox.querySelector(".lightbox__nav.prev");
  const nextBtn = lightbox.querySelector(".lightbox__nav.next");
  
  if (prevBtn) {
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigateLightbox(-1);
    });
  }
  
  if (nextBtn) {
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigateLightbox(1);
    });
  }
  
  // Navigazione tastiera
  document.addEventListener("keydown", (e) => {
    if (!lightbox.classList.contains("open")) return;
    if (e.key === "ArrowLeft") navigateLightbox(-1);
    if (e.key === "ArrowRight") navigateLightbox(1);
  });
}

function navigateLightbox(direction) {
  if (lightboxState.images.length === 0 || lightboxState.currentIndex < 0) return;
  
  let newIndex = lightboxState.currentIndex + direction;
  if (newIndex < 0) newIndex = lightboxState.images.length - 1;
  if (newIndex >= lightboxState.images.length) newIndex = 0;
  
  lightboxState.currentIndex = newIndex;
  const newSrc = lightboxState.images[newIndex];
  
  const lb = document.getElementById("lightbox");
  if (!lb) return;
  const img = lb.querySelector(".lightbox__image");
  const loader = lb.querySelector(".lightbox__loader");
  
  if (!img || !loader) return;
  
  resetZoom(img);
  loader.style.display = "grid";
  img.src = "";
  
  const preload = new Image();
  preload.onload = () => {
    img.src = newSrc;
    loader.style.display = "none";
  };
  preload.onerror = () => {
    loader.textContent = "Errore caricamento";
    loader.style.color = "var(--danger)";
  };
  preload.src = newSrc;
}

let zoomState = { scale: 1, x: 0, y: 0, isDragging: false };

function setupZoom(imgEl) {
  const container = imgEl.parentElement;

  // Wheel zoom (desktop)
  container.addEventListener("wheel", (e) => {
    if (!imgEl.src) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    applyZoom(imgEl, delta, e.clientX, e.clientY);
  }, { passive: false });

  // Double-click zoom toggle
  imgEl.addEventListener("dblclick", (e) => {
    if (zoomState.scale > 1) {
      resetZoom(imgEl);
    } else {
      applyZoom(imgEl, 2.5, e.clientX, e.clientY);
    }
  });

  // Pan drag quando zoomed
  imgEl.addEventListener("pointerdown", (e) => {
    if (zoomState.scale <= 1) return;
    zoomState.isDragging = true;
    zoomState.startX = e.clientX - zoomState.x;
    zoomState.startY = e.clientY - zoomState.y;
    imgEl.classList.add("zoomed");
    imgEl.setPointerCapture(e.pointerId);
  });

  imgEl.addEventListener("pointermove", (e) => {
    if (!zoomState.isDragging) return;
    zoomState.x = e.clientX - zoomState.startX;
    zoomState.y = e.clientY - zoomState.startY;
    updateTransform(imgEl);
  });

  imgEl.addEventListener("pointerup", () => {
    zoomState.isDragging = false;
    imgEl.classList.remove("zoomed");
  });

  imgEl.addEventListener("pointerleave", () => {
    zoomState.isDragging = false;
    imgEl.classList.remove("zoomed");
  });
}

function applyZoom(imgEl, factor, clientX, clientY) {
  const rect = imgEl.getBoundingClientRect();
  const centerX = clientX - rect.left - rect.width / 2;
  const centerY = clientY - rect.top - rect.height / 2;

  zoomState.scale = Math.max(1, Math.min(5, zoomState.scale * factor));

  if (zoomState.scale > 1) {
    zoomState.x -= centerX * (factor - 1);
    zoomState.y -= centerY * (factor - 1);
    clampPan(imgEl);
  } else {
    resetZoom(imgEl);
  }
  updateTransform(imgEl);
}

function clampPan(imgEl) {
  const rect = imgEl.getBoundingClientRect();
  const maxX = (rect.width * zoomState.scale - imgEl.parentElement.clientWidth) / 2;
  const maxY = (rect.height * zoomState.scale - imgEl.parentElement.clientHeight) / 2;
  zoomState.x = Math.max(-maxX, Math.min(maxX, zoomState.x));
  zoomState.y = Math.max(-maxY, Math.min(maxY, zoomState.y));
}

function updateTransform(imgEl) {
  imgEl.style.transform = `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;
}

function resetZoom(imgEl) {
  zoomState = { scale: 1, x: 0, y: 0, isDragging: false };
  imgEl.style.transform = "translate(0, 0) scale(1)";
  imgEl.classList.remove("zoomed");
}

function openLightbox(src, alt) {
  let lb = document.getElementById("lightbox");
  if (!lb) {
    createLightboxDOM();
    lb = document.getElementById("lightbox");
  }
  if (!lb) return;
  const img = lb.querySelector(".lightbox__image");
  const loader = lb.querySelector(".lightbox__loader");
  if (!img || !loader) return;

  resetZoom(img);
  img.src = "";
  img.alt = alt || "";
  loader.style.display = "grid";
  lb.classList.add("open");
  document.body.style.overflow = "hidden";

  // Preload immagine
  const preload = new Image();
  preload.onload = () => {
    img.src = src;
    loader.style.display = "none";
  };
  preload.onerror = () => {
    loader.textContent = "Errore caricamento";
    loader.style.color = "var(--danger)";
  };
  preload.src = src;
}

function closeLightbox() {
  const lb = document.getElementById("lightbox");
  if (!lb) return;
  lb.classList.remove("open");
  document.body.style.overflow = "";
  const img = lb.querySelector(".lightbox__image");
  if (img) resetZoom(img);
}

function initQuizNavigationGuard() {
  const handler = (event) => {
    if (!state.quiz.inProgress) return;
    const link = event.target.closest("a");
    if (!link || link.hasAttribute("data-close-success-dialog")) return;
    event.preventDefault();
    const target = link.href;
    showQuizAbandonDialog(target);
  };
  document.addEventListener("click", handler);
}

function showQuizAbandonDialog(navigateTo) {
  const total = state.quiz.questions.length;
  const dialog = document.createElement("div");
  dialog.className = "success-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <div class="success-dialog-card">
      <img src="assets/couple-mark.png" alt="Gloria e Beniamino">
      <p class="eyebrow">Attenzione</p>
      <h2>Stai uscendo dal quiz</h2>
      <p>Se esci ora il quiz verrà segnato come 0/${total} e non potrai rifarlo. Vuoi continuare?</p>
      <div class="gallery-actions" style="justify-content:center;margin-top:1.2rem">
        <button class="btn btn-primary" type="button" data-confirm-quiz-exit>Esci dal quiz</button>
        <button class="btn btn-secondary" type="button" data-cancel-quiz-exit>Resta</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  $("[data-cancel-quiz-exit]", dialog)?.addEventListener("click", close);
  $("[data-confirm-quiz-exit]", dialog)?.addEventListener("click", () => {
    close();
    if (navigateTo) {
      const beaconUrl = `${apiBaseUrl}/api/quiz/abandon`;
      const payload = JSON.stringify(state.quiz.participant);
      fetch(beaconUrl, { method: "POST", headers: { "Content-Type": "text/plain" }, body: payload, keepalive: true }).catch(() => {});
      state.quiz.inProgress = false;
      window.location.href = navigateTo;
    }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
}

function checkQuizAbandonedOnReload() {
  let abandoned = false;
  let stored = null;
  try {
    abandoned = sessionStorage.getItem("quizAbandoned") === "true";
    const raw = sessionStorage.getItem("quizParticipant");
    if (raw) stored = JSON.parse(raw);
  } catch {}
  try { sessionStorage.removeItem("quizAbandoned"); sessionStorage.removeItem("quizParticipant"); } catch {}
  if (!abandoned) return;
  if (stored?.name) {
    fetch(`${apiBaseUrl}/api/quiz/abandon`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(stored), keepalive: true }).catch(() => {});
  }
  const dialog = document.createElement("div");
  dialog.className = "success-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <div class="success-dialog-card">
      <img src="assets/couple-mark.png" alt="Gloria e Beniamino">
      <p class="eyebrow">Quiz terminato</p>
      <h2>Hai abbandonato il quiz</h2>
      <p>Ricaricando la pagina, il quiz è stato considerato abbandonato. Per rifarlo contatta gli sposi.</p>
      <button class="btn btn-primary" type="button" data-close-success-dialog>Ho capito</button>
    </div>`;
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  $("[data-close-success-dialog]", dialog)?.addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
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
    quizStartedAt: state.quiz.startedAt,
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
  return `<div class="empty-state empty-album-state"><span>✦</span><h3>L'album aspetta il primo ricordo</h3><p>Hai scattato una foto? Caricala tu: comparirà nell'album condiviso per tutti gli invitati.</p><a class="btn btn-primary" href="album.html#upload">Carica le tue foto</a></div>`;
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
  initGalleryDateFilter();
  initGalleryTimeFilter();
  initGalleryClearFilters();
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
    // Resetta sempre state.upload.files quando l'utente seleziona nuovi file
    state.upload.files = Array.from(input.files || []);
    state.upload.previewIndex = 0;
    renderUploadPreview(preview);
  });
  
  // Aggiungi listener per drag & drop che resetta lo stato
  const dropzone = $("[data-dropzone]");
  if (dropzone) {
    dropzone.addEventListener("drop", () => {
      // Il file input verrà aggiornato dal drop handler, ma assicuriamoci che
      // il prossimo change event venga sempre processato
      setTimeout(() => {
        if (input.files?.length > 0) {
          state.upload.files = Array.from(input.files);
          state.upload.previewIndex = 0;
          renderUploadPreview(preview);
        }
      }, 10);
    });
  }
}

function renderUploadPreview(preview = $("[data-upload-preview]")) {
  if (!preview) return;
  state.upload.previewUrls.forEach((url) => URL.revokeObjectURL(url));
  state.upload.previewUrls = [];
  preview.replaceChildren();
  const files = state.upload.files;
  if (!files.length) return;

  state.upload.previewUrls = files.map((file) => URL.createObjectURL(file));
  const idx = Math.min(state.upload.previewIndex, files.length - 1);
  state.upload.previewIndex = idx;

  const wrap = document.createElement("div");
  wrap.className = "upload-carousel";

  wrap.innerHTML = `
    <div class="upload-carousel-frame">
      <img src="${escapeAttr(state.upload.previewUrls[idx])}" alt="Anteprima ${escapeAttr(files[idx].name)}">
      <button class="remove-preview" type="button" data-remove-preview aria-label="Rimuovi foto">Rimuovi</button>
    </div>
    <div class="upload-carousel-actions">
      <button class="btn btn-ghost" type="button" data-prev-preview ${idx === 0 ? "disabled" : ""}>&larr; Precedente</button>
      <span class="upload-carousel-counter">${idx + 1} / ${files.length}</span>
      <button class="btn btn-ghost" type="button" data-next-preview ${idx === files.length - 1 ? "disabled" : ""}>Successiva &rarr;</button>
    </div>`;

  preview.appendChild(wrap);

  $("[data-remove-preview]", wrap).addEventListener("click", () => {
    state.upload.files.splice(state.upload.previewIndex, 1);
    if (state.upload.previewIndex >= state.upload.files.length) {
      state.upload.previewIndex = Math.max(0, state.upload.files.length - 1);
    }
    renderUploadPreview(preview);
  });

  $("[data-prev-preview]", wrap).addEventListener("click", () => {
    if (state.upload.previewIndex > 0) {
      state.upload.previewIndex -= 1;
      renderUploadPreview(preview);
    }
  });

  $("[data-next-preview]", wrap).addEventListener("click", () => {
    if (state.upload.previewIndex < state.upload.files.length - 1) {
      state.upload.previewIndex += 1;
      renderUploadPreview(preview);
    }
  });
}

function initUpload() {
  const form = $("[data-upload-form]");
  if (!form) return;

  let abortController = null;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    // Previene double-submit
    if (state.upload.uploading) return;

    const status = $("[data-upload-status]");
    const formData = new FormData(form);
    const uploaderName = String(formData.get("uploaderName") || "").trim();
    
    // Recupera files dall'input se state.upload.files è vuoto (fallback)
    const fileInput = form.querySelector('input[type="file"]');
    const files = state.upload.files.length > 0 
      ? state.upload.files 
      : Array.from(fileInput?.files || []);

    // Validazione pre-volo
    if (!uploaderName) {
      showUploadError(status, "Inserisci il tuo nome.");
      return;
    }
    if (!files.length) {
      showUploadError(status, "Seleziona almeno una foto.");
      return;
    }
    if (files.some((file) => file.size > 20 * 1024 * 1024)) {
      showUploadError(
        status,
        "Ogni foto non può superare i 20 MB (verrà compressa automaticamente).",
      );
      return;
    }

    // Imposta stato UI: disabilita form
    setUploadingState(true);
    status.innerHTML = "";
    let uploadedCount = 0;
    const errors = [];

    // Crea AbortController per questo batch
    abortController = new AbortController();
    const { signal } = abortController;

    try {
      for (const [index, file] of files.entries()) {
        if (signal.aborted) break;

        const line = createStatusLine(status, `Compressione ${index + 1}/${files.length}...`);

        try {
          // 1. Compressione con fallback
          const compressed = await compressImageToWebP(file, 1920, 0.82);
          const uploadType = compressed.type || "image/jpeg";
          const uploadExtension = uploadType === "image/webp" ? ".webp" : ".jpg";
          line.textContent = `Caricamento ${file.name} (${formatBytes(
            compressed.size,
          )})...`;

          // 2. Ottieni presigned URL con retry
          const presign = await withRetry(
            () =>
              api("/api/photos/presign", {
                method: "POST",
                admin: false,
                body: {
                  uploaderName,
                  fileName: file.name,
                  size: compressed.size,
                  type: uploadType,
                },
              }),
            2,
            1500,
          );

          // 3. Upload diretto a R2 con retry e timeout
          await uploadToR2WithRetry(presign.uploadUrl, compressed, signal);

          // 4. Conferma upload
          await api("/api/photos/confirm", {
            method: "POST",
            admin: false,
            body: {
              key: presign.key,
              uploaderName,
              originalName: file.name.replace(/\.[^.]+$/, uploadExtension),
              size: compressed.size,
            },
          });

          line.textContent = `✓ ${file.name}`;
          line.style.color = "var(--sage)";
          uploadedCount += 1;

        } catch (error) {
          const msg = `Errore su ${file.name}: ${error.message}`;
          line.textContent = msg;
          line.style.color = "var(--danger)";
          errors.push(msg);
          console.error("[Upload] Failed:", error);
        }
      }

      // Cleanup garantito: reset form e stato
      formResetGuaranteed();

      await loadGallery();

      // Feedback finale
      if (uploadedCount === files.length && files.length > 0) {
        showSuccessDialog(
          "Foto caricate",
          `Hai condiviso ${uploadedCount} foto nell'album. Grazie per il ricordo!`,
        );
      } else if (uploadedCount > 0) {
        showSuccessDialog(
          "Caricamento parziale",
          `${uploadedCount}/${files.length} foto caricate. ${errors.length
            ? `Errori: ${errors.slice(0, 2).join("; ")}`
            : ""}`,
        );
      } else if (errors.length) {
        showUploadError(status, `Nessuna foto caricata: ${errors[0]}`);
      }

    } finally {
      // Pulizia sempre eseguita, anche in caso di eccezione non catturata
      abortController = null;
      setUploadingState(false);
    }
  });

  // Pulsante annulla opzionale
  const cancelBtn = $("[data-upload-cancel]");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      if (abortController) {
        abortController.abort();
        setUploadingState(false);
      }
      formResetGuaranteed();
    });
  }
}

// === Helper functions per upload resiliente ===

function setUploadingState(uploading) {
  state.upload.uploading = uploading;
  const form = $("[data-upload-form]");
  const submitBtn = form?.querySelector('button[type="submit"]');
  const dropzone = $("[data-dropzone]");
  const fileInput = form?.querySelector('input[type="file"]');

  if (submitBtn) {
    submitBtn.disabled = uploading;
    submitBtn.textContent = uploading
      ? "Caricamento in corso..."
      : "Carica le mie foto nell'album";
  }
  if (dropzone) dropzone.style.pointerEvents = uploading ? "none" : "";
  if (fileInput) fileInput.disabled = uploading;
}

function showUploadError(status, message) {
  status.innerHTML = `<div class="upload-line" style="color:var(--danger)">${escapeHtml(
    message,
  )}</div>`;
}

function createStatusLine(container, text) {
  const line = document.createElement("div");
  line.className = "upload-line";
  line.textContent = text;
  container.appendChild(line);
  return line;
}

function formResetGuaranteed() {
  try {
    const form = $("[data-upload-form]");
    if (form) {
      // Resetta il form e soprattutto l'input file per permettere re-upload dello stesso file
      form.reset();
      const fileInput = form.querySelector('input[type="file"]');
      if (fileInput) {
        fileInput.value = ""; // Forza reset dell'input file
      }
      state.upload.files = [];
      renderUploadPreview();
    }
  } catch (e) {
    console.error("[Upload] Errore durante reset form:", e);
    // Fallback: pulizia manuale
    try { localStorage.removeItem("uploadInProgress"); } catch {}
  }
}

// Upload PUT a R2 con timeout e retry
async function uploadToR2WithRetry(uploadUrl, fileBlob, signal, retries = 2) {
  const timeoutMs = 120000; // 2 minuti timeout per file grandi

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Combina signal esterno + timeout interno
    const combinedSignal = combineAbortSignals(signal, controller.signal);

    try {
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": fileBlob.type || "application/octet-stream" },
        body: fileBlob,
        signal: combinedSignal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `R2 ${response.status}: ${errorText || "Upload fallito"}`,
        );
      }
      return; // Successo

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === "AbortError" || error.name === "DOMException") {
        throw new Error("Caricamento annullato o timeout raggiunto");
      }

      if (attempt === retries) throw error;

      console.warn(
        `[R2 Upload] Tentativo ${attempt + 1} fallito:`,
        error.message,
      );
      await sleep(2000 * Math.pow(2, attempt));
    }
  }
}

function combineAbortSignals(externalSignal, timeoutSignal) {
  if (!externalSignal) return timeoutSignal;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any([externalSignal, timeoutSignal]);
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (externalSignal.aborted || timeoutSignal.aborted) {
    controller.abort();
    return controller.signal;
  }
  externalSignal.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
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

async function compressImageToWebP(file, maxSide = 1920, quality = 0.82) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Formato file non valido.");
  }

  // 1. Leggi file come bitmap (gestisce EXIF orientation nativamente)
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, {
      colorSpaceConversion: "default",
      premultiplyAlpha: "none",
      resizeQuality: "high",
    });
  } catch {
    // Fallback per browser vecchi / formati non supportati (HEIC, etc.)
    bitmap = await loadImageFromFile(file);
  }

  const width = bitmap.width;
  const height = bitmap.height;

  // 2. Calcola nuove dimensioni mantenendo aspect ratio
  const ratio = Math.min(1, maxSide / Math.max(width, height));
  const newWidth = Math.round(width * ratio);
  const newHeight = Math.round(height * ratio);

  // 3. Canvas con eventuale correzione orientamento
  const canvas = document.createElement("canvas");
  canvas.width = newWidth;
  canvas.height = newHeight;

  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: false,
  });
  context.imageSmoothingEnabled = ratio < 1;
  context.imageSmoothingQuality = "high";
  // Disegna bitmap (già orientato correttamente da createImageBitmap)
  context.drawImage(bitmap, 0, 0, newWidth, newHeight);

  // Rilascia bitmap se disponibile
  if (bitmap.close) bitmap.close();

  // 4. Converti a WebP Blob con fallback JPEG
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          // Fallback: prova a creare JPEG se WebP fallisce
          createJpegFallback(file, file, quality)
            .then((jpegBlob) => resolve(jpegBlob))
            .catch(() => reject(new Error("Compressione non riuscita. Riprova con un file più piccola.")));
          return;
        }
        const webpFile = new File([blob], file.name.replace(/\.[^.]+$/, ".webp"), {
          type: "image/webp",
          lastModified: Date.now(),
        });
        resolve(webpFile);
      },
      "image/webp",
      quality,
    );
  });
}

// Fallback: crea JPEG dall'immagine canvas se WebP fallisce
async function createJpegFallback(originalBlob, originalFile, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(img, 0, 0);
      canvas.toBlob(
        (jpegBlob) => {
          if (!jpegBlob) return reject(new Error("JPEG fallback fallito."));
          const jpegFile = new File(
            [jpegBlob],
            originalFile.name.replace(/\.[^.]+$/, ".jpg"),
            { type: "image/jpeg" },
          );
          resolve(jpegFile);
        },
        "image/jpeg",
        quality !== undefined ? quality : 0.92,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Impossibile caricare immagine per fallback."));
    };
    // Usa un object URL per evitare di leggere il file due volte
    const url = URL.createObjectURL(originalBlob);
    img.src = url;
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
      reject(new Error("Impossibile leggere l'immagine."));
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

function initGalleryDateFilter() {
  const date = $("[data-photo-date]");
  if (!date) return;

  date.addEventListener("change", () => {
    state.gallery.date = date.value;
    state.gallery.page = 1;
    state.gallery.selected.clear();
    loadGallery(state.gallery.search, 1, date.value);
  });
}

function initGalleryTimeFilter() {
  const time = $("[data-photo-time]");
  if (!time) return;

  time.addEventListener("change", () => {
    state.gallery.time = time.value;
    state.gallery.page = 1;
    state.gallery.selected.clear();
    loadGallery(state.gallery.search, 1, state.gallery.date, time.value);
  });
}

function initGalleryClearFilters() {
  $("[data-clear-photo-filters]")?.addEventListener("click", () => {
    state.gallery.search = "";
    state.gallery.date = "";
    state.gallery.time = "";
    state.gallery.page = 1;
    state.gallery.selected.clear();
    const search = $("[data-photo-search]");
    const date = $("[data-photo-date]");
    const time = $("[data-photo-time]");
    if (search) search.value = "";
    if (date) date.value = "";
    if (time) time.value = "";
    loadGallery("", 1, "", "");
  });
}

/**
 * Carica la griglia dell'Album con skeleton UI durante il caricamento.
 * Mostra "Nessuna foto trovata" SOLO se la chiamata ha successo e l'array è vuoto.
 */
async function loadGallery(
  search = state.gallery.search,
  page = state.gallery.page,
  date = state.gallery.date,
  time = state.gallery.time,
) {
  const gallery = $("[data-gallery]");
  if (!gallery) return;

  // Mostra skeleton loader elegante stile soft luxury
  gallery.innerHTML = `
    <div class="gallery-skeleton">
      ${Array.from({ length: 9 }, () => '<div class="skeleton-item"></div>').join("")}
    </div>
  `;

  try {
    state.gallery.search = search;
    state.gallery.page = page;
    state.gallery.date = date;
    state.gallery.time = time;
    const query = `?search=${encodeURIComponent(search)}&date=${encodeURIComponent(date)}&time=${encodeURIComponent(time)}&limit=18&page=${page}`;
    const data = await api(`/api/photos${query}`, { admin: false });
    const photos = data.photos || [];
    state.gallery.items = photos;

    // Mostra messaggio "nessuna foto" SOLO se la chiamata ha successo (status 200)
    // e l'array restituito è effettivamente vuoto
    if (!photos.length) {
      gallery.innerHTML = `<div class="empty-state"><p>Nessuna foto trovata.</p></div>`;
      renderGalleryPagination(0, data.limit || 18, data.page || 1);
      updateGallerySelectionControls();
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
            <button class="download-pill" type="button" data-download="${escapeAttr(photo.downloadUrl)}" data-filename="${escapeAttr(photo.originalName || "foto-gloria-beniamino.jpg")}">Scarica</button>
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
    console.warn("Caricamento album fallito:", error.message);
    gallery.innerHTML = `
      <div class="empty-state">
        <p>⚠️ ${escapeHtml(error.message)}</p>
        <button type="button" onclick="loadGallery()" class="btn-retry">Riprova</button>
      </div>
    `;
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
      loadGallery(state.gallery.search, Number(button.dataset.galleryPage), state.gallery.date, state.gallery.time),
    ),
  );
}

async function downloadSelectedPhotos() {
  const keys = Array.from(state.gallery.selected);
  if (!keys.length) return;
  state.gallery.items
    .filter((photo) => keys.includes(photo.key))
    .forEach((photo, index) => {
      setTimeout(() => triggerDownload(photo.downloadUrl, photo.originalName || "foto-gloria-beniamino.jpg"), index * 500);
    });
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
    setTimeout(() => triggerDownload(photo.downloadUrl, photo.originalName), index * 500);
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
    const data = await api("/api/admin/photos", {
      method: "DELETE",
      body: { keys },
    });
    if (data.failed > 0) {
      alert(data.message || "Alcune foto non sono state eliminate.");
    }
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
              <button class="btn btn-ghost" type="button" data-move-question="down" data-question-id="${escapeAttr(question.id)}">Sposta giù</button>
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
    `${row.name}`.toLowerCase().includes(query),
  );
  state.adminPages.leaderboard = page;
  const pageRows = paginateAdminItems("leaderboard", rows);

  root.innerHTML = rows.length
    ? pageRows
        .map(
          (row) => `
          <li>
            <span class="rank">${row.position}</span>
            <span><strong>${escapeHtml(row.name)}</strong><small>${row.correctAnswers}/${row.total} risposte corrette · tempo ${formatElapsed(row.elapsedMs)}</small></span>
            <span class="score">${formatElapsed(row.elapsedMs)}</span>
            <button class="remove-submission" type="button" data-delete-submission="${escapeAttr(row.id)}" aria-label="Elimina ${escapeAttr(row.name)}">×</button>
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

// Helper: sleep with promise
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry with exponential backoff
async function withRetry(fn, retries = 2, baseDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        console.warn(
          `[Retry] Tentativo ${attempt + 1} fallito, riprovo tra ${Math.round(
            delay,
          )}ms:`,
          error.message,
        );
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

async function triggerDownload(url, filename) {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error();
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename || "foto-gloria-beniamino.jpg";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(url, "_blank");
  }
}









