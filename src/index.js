

const ALLOWED_ORIGIN = "https://avecare.github.io";

const ALLOWED_EXTENSIONS = new Set([
  "mp4", "mov", "mkv", "webm", "avi",
  "mp3", "wav", "m4a", "aac", "flac", "ogg"
]);

function json(data, status = 200, origin = "") {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  }

  return new Response(JSON.stringify(data), { status, headers });
}

function validSource(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    if (u.hostname === "localhost" || u.hostname.endsWith(".local")) return false;
    const ext = u.pathname.split(".").pop().toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

async function cloudConvert(path, key, options = {}) {
  return fetch("https://api.cloudconvert.com/v2" + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + key,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (origin && origin !== ALLOWED_ORIGIN) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }

    if (!env.CLOUDCONVERT_API_KEY) {
      return json({ error: "API secret is not configured" }, 500, origin);
    }

    if (url.pathname === "/api/convert" && request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400, origin);
      }

      const sourceUrl = String(body.url || "").trim();
      const format = String(body.format || "").toLowerCase();

      if (!validSource(sourceUrl)) {
        return json({
          error: "أدخل رابط HTTPS مباشر لملف تملكه أو لديك إذن باستخدامه."
        }, 400, origin);
      }

      if (!["mp3", "mp4"].includes(format)) {
        return json({ error: "الصيغة غير مدعومة." }, 400, origin);
      }

      if (format === "mp4" &&
          !/\.(mp4|mov|mkv|webm|avi)$/i.test(new URL(sourceUrl).pathname)) {
        return json({ error: "MP4 متاح لملفات الفيديو فقط." }, 400, origin);
      }

      const response = await cloudConvert(
        "/jobs",
        env.CLOUDCONVERT_API_KEY,
        {
          method: "POST",
          body: JSON.stringify({
            tasks: {
              "import-file": {
                operation: "import/url",
                url: sourceUrl
              },
              "convert-file": {
                operation: "convert",
                input: "import-file",
                output_format: format
              },
              "export-file": {
                operation: "export/url",
                input: "convert-file"
              }
            }
          })
        }
      );

      const result = await response.json();

      if (!response.ok) {
        return json({
          error: result.message || "تعذر بدء التحويل."
        }, 502, origin);
      }

      return json({
        jobId: result.data.id,
        status: result.data.status
      }, 202, origin);
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      const id = url.searchParams.get("id") || "";

      if (!/^[A-Za-z0-9-]{10,80}$/.test(id)) {
        return json({ error: "Invalid job ID" }, 400, origin);
      }

      const response = await cloudConvert(
        "/jobs/" + encodeURIComponent(id),
        env.CLOUDCONVERT_API_KEY
      );

      const result = await response.json();

      if (!response.ok) {
        return json({
          error: result.message || "تعذر قراءة حالة التحويل."
        }, 502, origin);
      }

      const job = result.data;
      const exportTask = (job.tasks || []).find(
        task => task.name === "export-file"
      );

      const file = exportTask &&
        exportTask.result &&
        exportTask.result.files &&
        exportTask.result.files[0];

      if (job.status === "finished" && file && file.url) {
        return json({
          status: "finished",
          downloadUrl: file.url,
          filename: file.filename || "converted-file"
        }, 200, origin);
      }

      if (job.status === "error") {
        return json({
          status: "error",
          error: "تعذرت معالجة الملف."
        }, 200, origin);
      }

      return json({
        status: job.status || "processing"
      }, 200, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  }
};
