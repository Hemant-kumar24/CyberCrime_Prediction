const path = require("path");
const fs = require("fs/promises");
const Papa = require("papaparse");
const Incident = require("../models/Incident");
const { normaliseCrimeType, severityFromIntensity, isWomenSafetyType } = require("../utils/incidentUtils");

const DATASET_PATH = path.join(__dirname, "..", "..", "python", "crime_dataset.csv");
const sanitizeHeader = (header = "") => header.replace(/^\uFEFF/, "").trim().toLowerCase();

const normaliseNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseInteger = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const purgeGeneralIncidents = async () => {
  await Incident.deleteMany({ crimeType: { $regex: /^general$/i } });
};

const buildLocation = (area, city) => {
  if (!area) return city || "Unknown";
  if (city && city !== "Unknown") {
    return `${area}, ${city}`;
  }
  return area;
};

const normaliseCsvRow = (row) => ({
  ...row,
  crimeType: row.crime_type || row.offence || row.category || row.type,
  latitude: row.lat ?? row.latitude ?? row.latitude_deg,
  longitude: row.lon ?? row.longitude ?? row.longitude_deg,
  date: row.date || row.incident_date || row.reported_on,
  time: row.time || row.incident_time || "",
  city: row.city || row.district || row.state,
  area: row.area || row.colony || row.locality || row.zone || row.street,
  intensity: row.intensity ?? row.severity ?? row.weight ?? row.score,
  description: row.description || row.summary || row.notes,
});

const prepareIncidentDocument = (payload, context = {}) => {
  const crimeType = normaliseCrimeType(payload.crimeType || payload.crime_type || payload.type);
  if (!crimeType) return null;

  const intensityRaw =
    normaliseNumber(payload.intensity ?? payload.severity ?? payload.weight ?? payload.score) ?? 0.6;
  const intensity = Math.min(Math.max(intensityRaw, 0.1), 2);
  const severity = severityFromIntensity(intensity);

  const lat = normaliseNumber(payload.latitude ?? payload.lat);
  const lon = normaliseNumber(payload.longitude ?? payload.lon);

  const dateValue = payload.date ?? payload.incidentDate ?? payload.incident_date ?? payload.reported_on;
  const date = dateValue ? new Date(dateValue) : new Date();
  if (Number.isNaN(date.getTime())) return null;

  const time = payload.time || payload.incidentTime || payload.incident_time || null;
  const city = payload.city || payload.district || payload.state || context.city || "Unknown";
  const area =
    payload.area ||
    payload.colony ||
    payload.locality ||
    payload.zone ||
    payload.street ||
    payload.location ||
    context.area ||
    "Unknown Area";

  const womenSafetyRaw =
    payload.isWomenSafety ??
    payload.is_women_safety ??
    payload.women_safety ??
    payload.womensafety ??
    context.isWomenSafety;
  let womenSafetyFlag = false;
  if (typeof womenSafetyRaw === "string") {
    womenSafetyFlag = ["true", "yes", "1"].includes(womenSafetyRaw.toLowerCase());
  } else if (typeof womenSafetyRaw === "boolean") {
    womenSafetyFlag = womenSafetyRaw;
  } else if (typeof womenSafetyRaw === "number") {
    womenSafetyFlag = womenSafetyRaw === 1;
  }
  if (!womenSafetyFlag) {
    womenSafetyFlag = isWomenSafetyType(crimeType, payload);
  }

  const document = {
    city,
    district: payload.district || context.district,
    zone: payload.zone || context.zone,
    street: payload.street || context.street,
    colony: payload.colony || context.colony,
    area,
    location: buildLocation(area, city),
    crimeType,
    description: payload.description || payload.summary || payload.notes || context.description,
    victimAge: parseInteger(payload.victimAge ?? payload.victim_age),
    gender: payload.gender || payload.victimGender || payload.victim_gender || null,
    date,
    time,
    intensity,
    severity,
    isWomenSafety: womenSafetyFlag,
    latitude: lat,
    longitude: lon,
    source: payload.source || context.source || "manual",
  };

  return document;
};

const insertIncident = async (payload, context) => {
  const document = prepareIncidentDocument(payload, context);
  if (!document) {
    throw new Error("Invalid incident payload");
  }
  const incident = await Incident.create(document);
  return incident;
};

const insertManyIncidents = async (payloads, context) => {
  const documents = payloads
    .map((payload) => prepareIncidentDocument(payload, context))
    .filter(Boolean);
  if (!documents.length) {
    return { insertedCount: 0 };
  }
  const result = await Incident.insertMany(documents);
  return { insertedCount: result.length };
};

const exportIncidentsToCsv = async () => {
  await purgeGeneralIncidents();
  const incidents = await Incident.find({}).sort({ date: 1 }).lean();
  const rows = incidents
    .filter((incident) => incident.crimeType && !/^general$/i.test(incident.crimeType))
    .map((incident) => ({
      City: incident.city || "",
      Area: incident.area || "",
      lat: incident.latitude ?? "",
      lon: incident.longitude ?? "",
      crime_type: incident.crimeType || "",
      date: incident.date ? new Date(incident.date).toISOString().slice(0, 10) : "",
      time: incident.time || "",
      intensity: incident.intensity ?? "",
    }));

  const csv = Papa.unparse(rows, {
    header: true,
    columns: ["City", "Area", "lat", "lon", "crime_type", "date", "time", "intensity"],
  });

  await fs.writeFile(DATASET_PATH, csv);
  return { exported: rows.length };
};

const seedIncidentsFromCsv = async () => {
  const existing = await Incident.estimatedDocumentCount();
  if (existing > 0) {
    return { seeded: 0 };
  }

  let csvRaw;
  try {
    csvRaw = await fs.readFile(DATASET_PATH, "utf-8");
  } catch {
    return { seeded: 0 };
  }

  const parsed = Papa.parse(csvRaw.replace(/\r\n/g, "\n"), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: sanitizeHeader,
    transform: (value) => (typeof value === "string" ? value.trim() : value),
  });

  const documents = parsed.data
    .map(normaliseCsvRow)
    .map((row) => prepareIncidentDocument(row, { source: "legacy-csv" }))
    .filter(Boolean);

  if (!documents.length) {
    return { seeded: 0 };
  }

  const result = await Incident.insertMany(documents, { ordered: false });
  await purgeGeneralIncidents();
  return { seeded: result.length };
};

const fetchIncidents = async (filters = {}) => {
  await purgeGeneralIncidents();
  const query = {};
  if (filters.crimeType) {
    query.crimeType = filters.crimeType;
  }
  if (filters.fromDate || filters.toDate) {
    query.date = {};
    if (filters.fromDate) query.date.$gte = filters.fromDate;
    if (filters.toDate) query.date.$lte = filters.toDate;
  }
  return Incident.find(query).lean();
};

module.exports = {
  insertIncident,
  insertManyIncidents,
  exportIncidentsToCsv,
  fetchIncidents,
  prepareIncidentDocument,
  buildLocation,
  normaliseCrimeType,
  severityFromIntensity,
  isWomenSafetyType,
  purgeGeneralIncidents,
  seedIncidentsFromCsv,
};
