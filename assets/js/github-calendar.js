class GitHubCalendar {
  constructor(containerId, username, options = {}) {
    this.containerId = containerId;
    this.username = username;
    this.container = document.getElementById(containerId);
    this.contributions = [];
    this.options = {
      weekStart: 0, // 0 = Sunday, 1 = Monday
      daysToShow: 167,
      perPage: 100, // para fallback REST
      maxPages: 10, // para fallback REST
      proxyBaseUrl: "/.netlify/functions/github-contributions",
      ...options,
    };
  }

  // ---------- FALLBACK: paginação do endpoint REST ----------
  async fetchEventsAllPages(username) {
    const allEvents = [];
    const perPage = this.options.perPage;
    const maxPages = this.options.maxPages;

    for (let page = 1; page <= maxPages; page++) {
      const url = `https://api.github.com/users/${username}/events/public?per_page=${perPage}&page=${page}`;
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github.v3+json" },
      });

      // Rate limit
      const remaining = res.headers.get("X-RateLimit-Remaining");
      const reset = res.headers.get("X-RateLimit-Reset");
      if (remaining !== null && Number(remaining) === 0) {
        const resetDate = reset ? new Date(Number(reset) * 1000) : null;
        const resetMsg = resetDate
          ? ` (reseta em ${resetDate.toLocaleString()})`
          : "";
        throw new Error(`Limite da API atingido.${resetMsg}`);
      }

      if (res.status === 404)
        throw new Error("Usuário GitHub não encontrado (404).");
      if (res.status === 403)
        throw new Error("Acesso negado / limite da API atingido (403).");
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Erro ao buscar eventos do GitHub: ${res.status} ${text}`
        );
      }

      const pageEvents = await res.json();
      if (!Array.isArray(pageEvents) || pageEvents.length === 0) break;
      allEvents.push(...pageEvents);
      if (pageEvents.length < perPage) break;
    }

    return allEvents;
  }

  // ---------- FRONTEND: busca preferencial via proxy GraphQL, fallback REST ----------
  async fetchContributions() {
    this.contributions = [];
    if (!this.container) return;
    this.container.innerHTML = this.renderLoading();

    // Try: proxy GraphQL (enviando from/to/days/weekStart)
    try {
      // calcula intervalo a enviar ao proxy (alinhado ao weekStart)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const toISO = today.toISOString();

      // calcula from com base em daysToShow
      const daysToShow = Number(this.options.daysToShow) || 167;
      const fromBase = new Date(today);
      fromBase.setDate(fromBase.getDate() - (daysToShow - 1));
      fromBase.setHours(0, 0, 0, 0);

      // alinha ao início da semana conforme weekStart
      const weekStart = Number(this.options.weekStart) || 0;
      const dayShift = (fromBase.getDay() - weekStart + 7) % 7;
      const fromAligned = new Date(fromBase);
      fromAligned.setDate(fromAligned.getDate() - dayShift);
      fromAligned.setHours(0, 0, 0, 0);

      // monta URL do proxy com query params
      const proxyUrl = `${this.options.proxyBaseUrl}/${encodeURIComponent(
        this.username
      )}?from=${encodeURIComponent(
        fromAligned.toISOString()
      )}&to=${encodeURIComponent(toISO)}&days=${encodeURIComponent(
        daysToShow
      )}&weekStart=${encodeURIComponent(weekStart)}`;

      const res = await fetch(proxyUrl);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Proxy indisponível: ${res.status} ${text}`);
      }

      const payload = await res.json();
      if (payload && Array.isArray(payload.days) && payload.days.length > 0) {
        // payload.days = [{date, count}, ...] (servidor já ordenou)
        this.contributions = payload.days.map((d) => ({
          date: d.date,
          count: d.count,
        }));
        // Garantir ordenação e normalização
        this.contributions.sort((a, b) => (a.date < b.date ? -1 : 1));
        this.contributions = this.contributions.map((c) => ({
          date: c.date,
          count: c.count,
        }));
        this.render();
        return;
      } else {
        throw new Error("Proxy retornou dados inválidos ou vazios.");
      }
    } catch (proxyErr) {
      console.warn(
        "Proxy GraphQL falhou, usando fallback REST. Motivo:",
        proxyErr.message
      );
      // Fallback: usar paginação do endpoint /events/public
      try {
        const events = await this.fetchEventsAllPages(this.username);

        // Mapear contagens por dia
        const contributionsMap = new Map();
        events.forEach((ev) => {
          if (!ev.created_at) return;
          const date = new Date(ev.created_at).toISOString().split("T")[0];
          contributionsMap.set(date, (contributionsMap.get(date) || 0) + 1);
        });

        // Gerar intervalo de dias dos últimos `daysToShow` dias
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const daysToShow = this.options.daysToShow;
        const startBase = new Date(today);
        startBase.setDate(startBase.getDate() - (daysToShow - 1));

        // Alinhar startDate ao início da semana (domingo por padrão)
        const startDate = new Date(startBase);
        const dayShift = (startDate.getDay() - this.options.weekStart + 7) % 7;
        startDate.setDate(startDate.getDate() - dayShift);
        startDate.setHours(0, 0, 0, 0);

        // Preencher this.contributions com um objeto por dia
        const contributionsArr = [];
        for (
          let d = new Date(startDate);
          d <= today;
          d.setDate(d.getDate() + 1)
        ) {
          const dateStr = d.toISOString().split("T")[0];
          const count = contributionsMap.get(dateStr) || 0;
          contributionsArr.push({ date: dateStr, count });
        }

        this.contributions = contributionsArr;
        this.render();
        return;
      } catch (restErr) {
        console.error("Fallback REST também falhou:", restErr);
        this.renderError(
          restErr.message || "Erro ao carregar contribuições do GitHub."
        );
        return;
      }
    }
  }

  // ---------- Níveis de contribuição (dinâmico) ----------
  getContributionLevel(count, max) {
    if (!count || count === 0) return 0;
    if (!max || max === 0) return 1;
    const ratio = count / max;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  // ---------- Render helpers (mantive como antes) ----------
  renderLoading() {
    return `
        <div class="github-calendar-card loading">
          <div class="github-calendar-header">
            <div class="github-logo">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
              <span>Minha atividade no Github</span>
            </div>
          </div>
          <div style="text-align:center;color:var(--light-gray)">Carregando atividades...</div>
        </div>
      `;
  }

  renderError(message = "Erro ao carregar atividades do GitHub") {
    if (!this.container) return;
    this.container.innerHTML = `
        <div class="github-calendar-card error">
          <div class="github-calendar-header">
            <div class="github-logo">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
              <span>Minha atividade no Github</span>
            </div>
          </div>
          <div class="error-message">
            <p>${message}</p>
          </div>
        </div>
      `;
  }

  render() {
    if (!this.container) return;

    const maxContributions = Math.max(
      0,
      ...this.contributions.map((c) => c.count)
    );
    const calendarHTML = `
        <div class="github-calendar-card">
          <div class="github-calendar-header">
            <div class="github-logo">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
              <span>Minha atividade no Github</span>
            </div>
          </div>
          <div class="github-calendar-grid" role="grid" aria-label="Calendário de contribuições">
            ${this.generateCalendarGrid(maxContributions)}
          </div>
          <div class="github-calendar-footer">
            <span class="legend-text">menos</span>
            <div class="legend-squares">
              <div class="legend-square level-0" title="0"></div>
              <div class="legend-square level-1" title="baixo"></div>
              <div class="legend-square level-2" title="médio"></div>
              <div class="legend-square level-3" title="alto"></div>
              <div class="legend-square level-4" title="muito alto"></div>
            </div>
            <span class="legend-text">mais</span>
          </div>
        </div>
      `;
    this.container.innerHTML = calendarHTML;
  }

  // ---------- Gera grid a partir do array this.contributions ----------
  generateCalendarGrid(maxContributions) {
    const weeks = [];
    const today = new Date();
    // normaliza "hoje" para 00:00:00 (evita problema de timezone)
    today.setHours(0, 0, 0, 0);

    if (!this.contributions || this.contributions.length === 0) {
      return `<div style="color:var(--light-gray)">Nenhuma contribuição registrada.</div>`;
    }

    // Garantir ordenação asc por data
    this.contributions.sort((a, b) => (a.date < b.date ? -1 : 1));

    // Primeiro dia do array (iso "YYYY-MM-DD")
    const firstDateIso = this.contributions[0].date;
    // Criar Date consistente (evita parse ambíguo com timezone)
    const firstDate = new Date(firstDateIso + "T00:00:00");
    firstDate.setHours(0, 0, 0, 0);

    // Alinhar startDate ao início da semana (weekStart: 0=Dom,1=Seg)
    const dayShift = (firstDate.getDay() - this.options.weekStart + 7) % 7;
    const startDate = new Date(firstDate);
    startDate.setDate(startDate.getDate() - dayShift);
    startDate.setHours(0, 0, 0, 0);

    // Criar mapa para lookup rápido: dateStr -> count
    const contributionsMap = new Map();
    this.contributions.forEach((c) => {
      const key = c.date;
      contributionsMap.set(key, c.count);
    });

    // Iterar por semanas, do startDate até hoje
    for (
      let weekStart = new Date(startDate);
      weekStart <= today;
      weekStart.setDate(weekStart.getDate() + 7)
    ) {
      const weekSquares = [];

      for (let day = 0; day < 7; day++) {
        const currentDate = new Date(weekStart);
        currentDate.setDate(weekStart.getDate() + day);
        currentDate.setHours(0, 0, 0, 0);

        const dateStr = currentDate.toISOString().split("T")[0];
        const count = contributionsMap.get(dateStr) || 0;

        if (currentDate <= today) {
          const level = this.getContributionLevel(count, maxContributions);
          weekSquares.push(`
              <div class="contribution-square level-${level}"
                   role="button"
                   tabindex="0"
                   data-date="${dateStr}"
                   data-count="${count}"
                   aria-label="${dateStr}: ${count} contribuições"
                   title="${dateStr}: ${count} contribuições">
              </div>
            `);
        } else {
          weekSquares.push('<div class="contribution-square empty"></div>');
        }
      }

      weeks.push(`<div class="calendar-week">${weekSquares.join("")}</div>`);
    }

    return weeks.join("");
  }

  init() {
    this.fetchContributions();
  }
}

// Inicializar quando o DOM estiver carregado
document.addEventListener("DOMContentLoaded", function () {
  const githubCalendar = new GitHubCalendar(
    "github-calendar-container",
    "Gildaciolopes",
    {
      proxyBaseUrl: "/.netlify/functions/github-contributions",
      maxPages: 10,
      perPage: 100,
      weekStart: 0,
      daysToShow: 167,
    }
  );
  githubCalendar.init();
});
