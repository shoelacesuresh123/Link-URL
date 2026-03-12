import express from "express";
import multer from "multer";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// Set up multer for file uploads
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets (if you have a /public folder)
app.use(express.static(path.join(__dirname, "public")));

/**
 * Serve the main UI (views/index.html)
 * This works whether views/ is at repo root or under src/views
 */
app.get("/", (req, res) => {
  const p1 = path.join(process.cwd(), "views", "index.html");
  const p2 = path.join(process.cwd(), "src", "views", "index.html");

  const filePath = fs.existsSync(p1) ? p1 : p2;

  if (!fs.existsSync(filePath)) {
    return res
      .status(500)
      .send(
        "UI file not found. Expected views/index.html (or src/views/index.html)."
      );
  }

  res.sendFile(filePath);
});

// Helper to escape CSV fields
function escapeCSV(field) {
  if (field === null || field === undefined) return "";
  const str = String(field);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Audit endpoint
app.post("/api/audit", upload.single("urlFile"), async (req, res) => {
  try {
    let urls = [];

    // Parse URLs from textarea
    if (req.body.urls) {
      const textUrls = req.body.urls
        .split("\n")
        .map((u) => u.trim())
        .filter(Boolean);
      urls.push(...textUrls);
    }

    // Parse URLs from uploaded file
    if (req.file) {
      const fileContent = fs.readFileSync(req.file.path, "utf-8");
      const fileUrls = fileContent
        .split("\n")
        .map((u) => u.trim())
        .filter(Boolean);
      urls.push(...fileUrls);

      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
    }

    // Deduplicate
    urls = [...new Set(urls)];

    if (urls.length === 0) {
      return res.status(400).json({ error: "No URLs provided." });
    }

    const matchPattern = req.body.matchPattern || "/us/en";
    const results = [];

    // Launch Playwright (Render-safe)
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext();

    for (const url of urls) {
      let errorMsg = "";
      let extractedLinks = [];

      const targetUrl = url.startsWith("http") ? url : `https://${url}`;

      try {
        const page = await context.newPage();

        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        extractedLinks = await page.evaluate((pattern) => {
          const links = Array.from(document.querySelectorAll("a[href]"));
          const results = [];
          const seenHrefs = new Set();

          for (const a of links) {
            const href = a.getAttribute("href");
            if (!href) continue;
            if (!href.includes(pattern)) continue;
            if (seenHrefs.has(href)) continue;

            // Ignore links inside language/locale selectors
            const langSelector =
              'header, [aria-label*="lang" i], [aria-label*="language" i], [aria-label*="locale" i], [class*="lang" i], [class*="language" i], [class*="locale" i], [id*="lang" i], [id*="language" i], [id*="locale" i]';
            if (a.closest(langSelector)) continue;

            seenHrefs.add(href);

            let linkText = (a.innerText || "").trim();
            if (!linkText) linkText = (a.getAttribute("aria-label") || "").trim();
            if (!linkText) linkText = (a.getAttribute("title") || "").trim();

            const container = a.closest("section, article, nav, header, footer, main, div");
            let surroundingText = "";
            if (container) {
              surroundingText = (container.innerText || "").trim().substring(0, 200);
            }

            const lowerSurrounding = surroundingText.toLowerCase();
            if (
              lowerSurrounding.includes("choisissez la langue") ||
              lowerSurrounding.includes("canada - français") ||
              lowerSurrounding.includes("select language") ||
              lowerSurrounding.includes("language")
            ) {
              continue;
            }

            results.push({
              matched_link: href,
              link_text: linkText,
              surrounding_text: surroundingText,
            });
          }

          return results;
        }, matchPattern);

        await page.close();
      } catch (err) {
        errorMsg = err?.message || String(err);
      }

      if (errorMsg || extractedLinks.length === 0) {
        results.push({
          page_url: targetUrl,
          matched_link: "",
          link_text: "",
          surrounding_text: "",
          error: errorMsg,
        });
      } else {
        for (const link of extractedLinks) {
          results.push({
            page_url: targetUrl,
            matched_link: link.matched_link,
            link_text: link.link_text,
            surrounding_text: link.surrounding_text,
            error: "",
          });
        }
      }
    }

    await browser.close();

    res.json({ results });
  } catch (error) {
    console.error("Audit error:", error);
    res.status(500).json({ error: "An error occurred during the audit." });
  }
});

// CSV Download endpoint
app.post("/api/download-csv", (req, res) => {
  try {
    const { results } = req.body;

    if (!results || !Array.isArray(results)) {
      return res.status(400).send("Invalid results data");
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="audit_results.csv"');

    res.write("page_url,matched_link,link_text,surrounding_text,error\n");

    for (const row of results) {
      const csvRow = [
        escapeCSV(row.page_url),
        escapeCSV(row.matched_link),
        escapeCSV(row.link_text),
        escapeCSV(row.surrounding_text),
        escapeCSV(row.error),
      ].join(",");

      res.write(csvRow + "\n");
    }

    res.end();
  } catch (error) {
    console.error("CSV generation error:", error);
    res.status(500).send("Error generating CSV");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
