const fs = require("node:fs/promises");
const path = require("node:path");

const API_URL = "https://www.biznesradar.pl/get-quotes-json/";
const TIME_ZONE = "Europe/Warsaw";
const LISTINGS_PATH = path.join(__dirname, "listings.json");
const OUTPUT_DIR = path.join(__dirname, "quotes");
const MAX_CONCURRENCY = 5;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;

const csvHeaders = [
  "Data",
  "Czas",
  "Kod",
  "Spolka",
  "Numer",
  "Kurs",
  "Zmiana",
  "Zmiana %",
  "Wolumen",
  "Wartosc",
];

function getDateParts(timestamp = Date.now()) {
  const formatter = new Intl.DateTimeFormat("pl-PL", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  };
}

function getTradingDate() {
  const parts = getDateParts();
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getArchiveDate(tradingDate) {
  return tradingDate.replaceAll("-", "");
}

function formatDate(timestamp) {
  const parts = getDateParts(timestamp * 1000);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1000));
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function numberOrBlank(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "";
}

function buildRows(listing, quotes, tradingDate) {
  return quotes
    .filter((quote) => formatDate(quote.ts) === tradingDate)
    .sort((left, right) => left.ts - right.ts)
    .map((quote, index) => {
      const change = Number.isFinite(quote.c) && Number.isFinite(quote.o)
        ? quote.c - quote.o
        : NaN;
      const changePercent = Number.isFinite(change) && quote.o
        ? (change / quote.o) * 100
        : NaN;

      return [
        tradingDate,
        formatTime(quote.ts),
        listing.code,
        listing.name,
        index + 1,
        numberOrBlank(quote.c, 4),
        numberOrBlank(change, 4),
        numberOrBlank(changePercent, 2),
        Number.isFinite(quote.v) ? quote.v : "",
        numberOrBlank(quote.mc, 2),
      ];
    });
}

async function fetchListing(listing, tradingDate) {
  const body = new URLSearchParams({
    oid: listing.id,
    range: "1d",
    type: "lin",
    without_operations: "0",
    currency_exchange: "0",
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          accept: "application/json, text/javascript, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          origin: "https://www.biznesradar.pl",
          referer: `https://www.biznesradar.pl/transakcje/${listing.code}`,
          "user-agent": "gpw-tracker/1.0",
          "x-requested-with": "XMLHttpRequest",
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (payload.error || !Array.isArray(payload.data) || !payload.data[0]) {
        throw new Error("Nieprawidlowa odpowiedz API");
      }

      return buildRows(listing, payload.data[0].quotes || [], tradingDate);
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`${listing.code}: ${error.message}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  return [];
}

async function createArchive(archivePath, files) {
  await fs.rm(archivePath, { force: true });

  if (process.platform === "win32") {
    const powershellFiles = files.map((file) => `'${file.replaceAll("'", "''")}'`).join(",");
    const command = `Compress-Archive -LiteralPath @(${powershellFiles}) -DestinationPath '${archivePath.replaceAll("'", "''")}'`;
    await new Promise((resolve, reject) => {
      require("node:child_process").execFile("powershell", ["-NoProfile", "-Command", command], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return;
  }

  await new Promise((resolve, reject) => {
    require("node:child_process").execFile("zip", ["-j", "-q", archivePath, ...files], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main() {
  const listings = JSON.parse(await fs.readFile(LISTINGS_PATH, "utf8"));
  const tradingDate = getTradingDate();
  const rowsByCode = new Map();
  const failures = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < listings.length) {
      const listing = listings[nextIndex];
      nextIndex += 1;

      try {
        rowsByCode.set(listing.code, await fetchListing(listing, tradingDate));
      } catch (error) {
        failures.push(error.message);
        console.error(error.message);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, listings.length) }, worker),
  );

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputFiles = [];
  let rowCount = 0;

  for (const listing of listings) {
    const rows = rowsByCode.get(listing.code) || [];
    const csv = [csvHeaders, ...rows]
      .map((row) => row.map(csvEscape).join(";"))
      .join("\n") + "\n";
    const outputPath = path.join(OUTPUT_DIR, `${listing.code}.csv`);

    await fs.writeFile(outputPath, csv, "utf8");
    outputFiles.push(outputPath);
    rowCount += rows.length;
  }

  const archivePath = path.join(__dirname, `quotes-${getArchiveDate(tradingDate)}.zip`);
  await createArchive(archivePath, outputFiles);
  console.log(`Zapisano ${rowCount} rekordow w ${outputFiles.length} plikach CSV dla ${tradingDate}`);
  console.log(`Utworzono archiwum ${archivePath}`);

  if (failures.length > 0) {
    throw new Error(`Nie udalo sie pobrac ${failures.length} spolek`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});