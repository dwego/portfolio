// Função Netlify para retornar contributionCalendar via GitHub GraphQL

export async function handler(event) {
  try {
    // captura username (rota ou querystring)
    const username =
      (event.pathParameters && event.pathParameters.username) ||
      (event.queryStringParameters && event.queryStringParameters.username) ||
      (event.queryStringParameters && event.queryStringParameters.user) ||
      (event.path && event.path.split("/").pop());

    if (!username) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "username é obrigatório na rota ou como query param.",
        }),
      };
    }

    // query params
    const query = event.queryStringParameters || {};

    // toISO: se enviado, usa; senão usa hoje
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const toISO = query.to || today.toISOString();

    let fromISO = null;

    // if query.days provided, compute fromISO from 'to'
    if (query.days) {
      const days = Number(query.days);
      if (!Number.isNaN(days) && days > 0) {
        const toDate = new Date(toISO);
        toDate.setHours(0, 0, 0, 0);
        const fromDate = new Date(toDate);
        fromDate.setDate(fromDate.getDate() - (days - 1));
        fromDate.setHours(0, 0, 0, 0);

        // optional align to weekStart if provided
        const weekStart = query.weekStart ? Number(query.weekStart) : null;
        if (weekStart === 0 || weekStart === 1) {
          const dayShift = (fromDate.getDay() - weekStart + 7) % 7;
          fromDate.setDate(fromDate.getDate() - dayShift);
          fromDate.setHours(0, 0, 0, 0);
        }

        fromISO = fromDate.toISOString();
      }
    }

    // se fromISO não calculado via days, prioriza query.from, senão usa 1 ano atrás (fallback)
    if (!fromISO) {
      fromISO =
        query.from ||
        new Date(
          new Date(toISO).setFullYear(new Date(toISO).getFullYear() - 1)
        ).toISOString();
    }

    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) {
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "GITHUB_TOKEN não configurado no ambiente.",
        }),
      };
    }

    const GRAPHQL_QUERY = `
        query($login:String!, $from:DateTime!, $to:DateTime!) {
          user(login: $login) {
            contributionsCollection(from: $from, to: $to) {
              contributionCalendar {
                weeks {
                  contributionDays {
                    date
                    contributionCount
                  }
                }
              }
            }
          }
        }
      `;

    const body = {
      query: GRAPHQL_QUERY,
      variables: { login: username, from: fromISO, to: toISO },
    };

    const ghRes = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "User-Agent": "netlify-github-calendar",
      },
      body: JSON.stringify(body),
    });

    if (!ghRes.ok) {
      const txt = await ghRes.text();
      return {
        statusCode: ghRes.status,
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        },
        body: `GitHub GraphQL error: ${txt}`,
      };
    }

    const json = await ghRes.json();
    if (json.errors && json.errors.length) {
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "Erro do GitHub GraphQL",
          details: json.errors,
        }),
      };
    }

    const weeks =
      json.data.user.contributionsCollection.contributionCalendar.weeks || [];
    let days = [];
    weeks.forEach((w) => {
      w.contributionDays.forEach((d) =>
        days.push({ date: d.date, count: d.contributionCount })
      );
    });

    // Ordena asc
    days.sort((a, b) => (a.date < b.date ? -1 : 1));

    // Se query.days foi passada, garante limitar o número de dias retornados
    if (query.days && Number(query.days) > 0) {
      const wanted = Number(query.days);
      if (days.length > wanted) {
        days = days.slice(days.length - wanted);
      }
    }

    // Cache control header: permite CDN/cache de borda
    const CACHE_TTL_SECONDS = process.env.CACHE_TTL_SECONDS
      ? Number(process.env.CACHE_TTL_SECONDS)
      : 600; // 10 min

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      },
      body: JSON.stringify({ days }),
    };
  } catch (err) {
    console.error("Error in function:", err);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Erro interno na função",
        details: err.message,
      }),
    };
  }
}
