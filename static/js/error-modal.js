/**
 * Error Modal Utility — ZXSharer
 * Displays a popup modal with user-friendly error messages and technical error details.
 */

"use strict";

(function () {
  /**
   * Ensures the modal DOM elements exist in the body.
   */
  function ensureModalDOM() {
    if (document.getElementById("error-modal")) return;

    const modalHTML = `
      <div id="error-modal" class="error-modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="error-modal-title">
        <div class="error-modal-card">
          <div class="error-modal-header">
            <div class="error-modal-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h3 id="error-modal-title" class="error-modal-title">Ocorreu um erro</h3>
            <button id="error-modal-close-btn" class="error-modal-close" aria-label="Fechar">&times;</button>
          </div>

          <div class="error-modal-body">
            <p id="error-modal-message" class="error-modal-msg"></p>

            <details class="error-modal-tech-details" open>
              <summary class="error-modal-tech-summary">
                <span>Detalhes técnicos do erro</span>
                <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </summary>
              <pre id="error-modal-tech-content" class="error-modal-tech-code"></pre>
            </details>
          </div>

          <div class="error-modal-footer">
            <button id="error-modal-copy-btn" class="btn btn--secondary btn--sm">
              <svg viewBox="0 0 20 20" fill="currentColor" class="icon-sm"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"/></svg>
              <span>Copiar Detalhes</span>
            </button>
            <button id="error-modal-ok-btn" class="btn btn--primary btn--sm">Entendi</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHTML);

    const modal = document.getElementById("error-modal");
    const closeBtn = document.getElementById("error-modal-close-btn");
    const okBtn = document.getElementById("error-modal-ok-btn");
    const copyBtn = document.getElementById("error-modal-copy-btn");

    function closeModal() {
      modal.hidden = true;
      modal.classList.remove("active");
    }

    closeBtn.addEventListener("click", closeModal);
    okBtn.addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });

    copyBtn.addEventListener("click", () => {
      const title = document.getElementById("error-modal-title").textContent;
      const msg = document.getElementById("error-modal-message").textContent;
      const tech = document.getElementById("error-modal-tech-content").textContent;
      const fullText = `[ERRO]: ${title}\n[MENSAGEM]: ${msg}\n\n[DETALHES TÉCNICOS]:\n${tech}`;

      navigator.clipboard.writeText(fullText).then(() => {
        const btnSpan = copyBtn.querySelector("span");
        if (btnSpan) btnSpan.textContent = "Copiado!";
        setTimeout(() => {
          if (btnSpan) btnSpan.textContent = "Copiar Detalhes";
        }, 2000);
      }).catch(err => {
        console.warn("Failed to copy error details:", err);
      });
    });
  }

  /**
   * Displays the popup error modal.
   * @param {string} title - User-facing error title
   * @param {string} message - User-facing description
   * @param {any} technicalDetail - Technical error object, string, or Exception
   */
  window.showErrorModal = function (title, message, technicalDetail) {
    ensureModalDOM();

    const modal = document.getElementById("error-modal");
    const titleEl = document.getElementById("error-modal-title");
    const msgEl = document.getElementById("error-modal-message");
    const techEl = document.getElementById("error-modal-tech-content");

    titleEl.textContent = title || "Erro do Sistema";
    msgEl.textContent = message || "Ocorreu um erro inesperado.";

    let formattedTech = "";
    if (technicalDetail) {
      if (typeof technicalDetail === "object") {
        if (technicalDetail instanceof Error) {
          formattedTech = `[${technicalDetail.name}]\nMessage: ${technicalDetail.message}\n\nStack Trace:\n${technicalDetail.stack || "Sem stack trace disponível"}`;
        } else if (technicalDetail instanceof Event && technicalDetail.type) {
          formattedTech = `[Event Error]\nType: ${technicalDetail.type}\nTarget: ${technicalDetail.target}`;
        } else {
          try {
            formattedTech = JSON.stringify(technicalDetail, null, 2);
          } catch {
            formattedTech = String(technicalDetail);
          }
        }
      } else {
        formattedTech = String(technicalDetail);
      }
    } else {
      formattedTech = "Nenhuma informação técnica adicional.";
    }

    techEl.textContent = formattedTech;

    modal.hidden = false;
    // Trigger reflow for animation
    void modal.offsetWidth;
    modal.classList.add("active");
  };

  // Global unhandled error handlers
  window.addEventListener("error", (event) => {
    console.error("Global Error Caught:", event.error || event.message);
    window.showErrorModal(
      "Erro de Execução (Frontend)",
      event.message || "Ocorreu um erro inesperado na aplicação.",
      event.error || { message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno }
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    console.error("Unhandled Promise Rejection:", event.reason);
    window.showErrorModal(
      "Falha em Operação Assíncrona",
      "Uma requisição ou promessa falhou sem tratamento prévio.",
      event.reason
    );
  });
})();
