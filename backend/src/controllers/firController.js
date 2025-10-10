const Papa = require("papaparse");
const {
  insertIncident,
  insertManyIncidents,
  exportIncidentsToCsv,
  normaliseCrimeType,
} = require("../services/incidentService");

const sanitizeHeader = (header = "") => header.replace(/^\uFEFF/, "").trim().toLowerCase();

const PARSE_BASE_OPTIONS = {
  header: true,
  dynamicTyping: false,
  skipEmptyLines: "greedy",
  transformHeader: sanitizeHeader,
  transform: (value) => (typeof value === "string" ? value.trim() : value),
};

const fatalParseError = (error) =>
  error?.type === "Delimiter" || error?.type === "Quotes" || error?.code === "UndetectableDelimiter";

const parseCsvFlexible = (csvText) => {
  const normalisedText = csvText.replace(/\r\n/g, "\n");
  const attempts = [
    { label: "auto", options: {} },
    { label: "semicolon", options: { delimiter: ";" } },
    { label: "tab", options: { delimiter: "\t" } },
    { label: "pipe", options: { delimiter: "|" } },
  ];

  for (const attempt of attempts) {
    const parsed = Papa.parse(normalisedText, { ...PARSE_BASE_OPTIONS, ...attempt.options });
    const fatalErrors = parsed.errors?.filter(fatalParseError) ?? [];
    if (!fatalErrors.length) {
      if (parsed.errors?.length) {
        console.warn(`CSV parsed with minor warnings (${attempt.label})`, parsed.errors);
      }
      return parsed;
    }
  }

  return Papa.parse(normalisedText.replace(/;/g, ","), { ...PARSE_BASE_OPTIONS, delimiter: "," });
};

const requiredFields = ["victimAge", "gender", "district", "zone", "street", "colony", "crimeType"];

const createFirEntry = async (req, res) => {
  const payload = req.body ?? {};
  const missing = requiredFields.filter((field) => {
    const value = payload[field];
    return value === undefined || value === null || value === "";
  });

  if (missing.length) {
    res.status(400).json({ message: `Missing required fields: ${missing.join(", ")}` });
    return;
  }

  const crimeType = normaliseCrimeType(payload.crimeType);
  if (!crimeType) {
    res.status(400).json({ message: "Invalid crime type provided." });
    return;
  }

  const areaParts = [payload.colony, payload.street].filter(Boolean);
  const area = areaParts.length ? areaParts.join(", ") : payload.zone || "Unknown Area";
  const city = payload.district || "Unknown";

  try {
    const incident = await insertIncident(
      {
        ...payload,
        crimeType,
        area,
        city,
        date: payload.incidentDate || new Date().toISOString().slice(0, 10),
        time: payload.incidentTime || new Date().toISOString().slice(11, 16),
        latitude: payload.latitude,
        longitude: payload.longitude,
        intensity: payload.intensity,
        description: payload.description,
      },
      { source: "fir-form" }
    );

    await exportIncidentsToCsv();

    res.status(201).json({
      message: "FIR recorded and dataset updated",
      incident: incident.toObject(),
    });
  } catch (error) {
    console.error("Failed to store FIR:", error);
    res.status(500).json({ message: "Failed to record FIR", error: error.message });
  }
};

const uploadFirDataset = async (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "CSV file is required" });
    return;
  }

  try {
    const CSVText = req.file.buffer.toString("utf-8");
    const parsed = parseCsvFlexible(CSVText);

    const fatalErrors = parsed.errors?.filter(fatalParseError) ?? [];
    if (fatalErrors.length) {
      res.status(400).json({
        message: "Failed to parse CSV file",
        errors: fatalErrors.map(({ message, row }) => ({ message, row })),
      });
      return;
    }

    const payloads = parsed.data
      .map((row) => {
        const crimeType = normaliseCrimeType(row.crime_type || row.offence || row.category || row.type || "");
        if (!crimeType) return null;
        return {
          crimeType,
          city: row.city || row.district || row.state || "Unknown",
          district: row.district,
          zone: row.zone,
          street: row.street,
          colony: row.colony,
          area: row.area,
          latitude: row.lat ?? row.latitude ?? row.latitude_deg,
          longitude: row.lon ?? row.longitude ?? row.longitude_deg,
          intensity: row.intensity || row.severity || row.weight || 0.6,
          date: row.date || row.incident_date || row.reported_on || new Date().toISOString().slice(0, 10),
          time: row.time || row.incident_time || "",
          description: row.description || row.summary || row.notes,
          source: "csv-upload",
          gender: row.gender,
          victimAge: row.victimAge || row.victim_age,
        };
      })
      .filter(Boolean);

    if (!payloads.length) {
      res.status(400).json({ message: "No valid rows detected in uploaded CSV" });
      return;
    }

    const result = await insertManyIncidents(payloads, { source: "csv-upload" });
    await exportIncidentsToCsv();

    res.status(201).json({
      message: `${result.insertedCount} records ingested into dataset`,
      totalRows: result.insertedCount,
    });
  } catch (error) {
    console.error("CSV ingest failed:", error);
    res.status(500).json({ message: "Failed to process dataset", error: error.message });
  }
};

module.exports = {
  createFirEntry,
  uploadFirDataset,
};
