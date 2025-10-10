const Incident = require("../models/Incident");
const { purgeGeneralIncidents, seedIncidentsFromCsv } = require("../services/incidentService");

const escapeRegExp = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const aggregateRows = (rows) => {
  const grouped = new Map();

  rows.forEach((row) => {
    const key = `${row.lat}|${row.lon}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        lat: row.lat,
        lon: row.lon,
        count: 0,
        totalIntensity: 0,
        latestDate: row.date,
        typeCounts: new Map(),
      });
    }

    const entry = grouped.get(key);
    entry.count += 1;
    entry.totalIntensity += row.intensity;
    if (!entry.latestDate || row.date > entry.latestDate) {
      entry.latestDate = row.date;
    }
    entry.typeCounts.set(row.crimeType, (entry.typeCounts.get(row.crimeType) || 0) + 1);
  });

  const maxCount =
    Array.from(grouped.values()).reduce((acc, item) => Math.max(acc, item.count), 0) || 1;

  return Array.from(grouped.values()).map((entry) => {
    const dominant = Array.from(entry.typeCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    return {
      lat: entry.lat,
      lon: entry.lon,
      count: entry.count,
      avg_intensity: Number((entry.totalIntensity / entry.count).toFixed(3)),
      normalized_count: Number((entry.count / maxCount).toFixed(3)),
      date: entry.latestDate,
      crime_type: dominant ? dominant[0] : "Unknown",
    };
  });
};

const buildMeta = (rows) => ({
  dates: Array.from(new Set(rows.map((row) => row.date))).sort(),
  crime_types: Array.from(new Set(rows.map((row) => row.crimeType))).sort(),
});

const getCrimeData = async (req, res) => {
  try {
    await seedIncidentsFromCsv();
    await purgeGeneralIncidents();
    const incidents = await Incident.find({})
      .select({
        latitude: 1,
        longitude: 1,
        intensity: 1,
        date: 1,
        crimeType: 1,
      })
      .lean();

    const allRows = incidents
      .map((incident) => {
        if (!incident.crimeType || /^general$/i.test(incident.crimeType)) return null;
        const latValue = Number.parseFloat(incident.latitude);
        const lonValue = Number.parseFloat(incident.longitude);
        if (!Number.isFinite(latValue) || !Number.isFinite(lonValue)) return null;
        const date = incident.date ? new Date(incident.date) : null;
        if (!date || Number.isNaN(date.getTime())) return null;
        const intensityValue = Number.parseFloat(incident.intensity);
        const intensity = Number.isFinite(intensityValue) ? intensityValue : 0.6;
        return {
          lat: Number(latValue.toFixed(6)),
          lon: Number(lonValue.toFixed(6)),
          intensity,
          date: date.toISOString().slice(0, 10),
          crimeType: incident.crimeType,
        };
      })
      .filter(Boolean);

    let rows = allRows;

    if (req.query.date) {
      const requested = req.query.date;
      const datePattern = new RegExp(`^${escapeRegExp(requested)}$`, "i");
      rows = rows.filter((row) => datePattern.test(row.date));
    }

    if (req.query.crime_type) {
      const pattern = new RegExp(`^${escapeRegExp(req.query.crime_type)}$`, "i");
      rows = rows.filter((row) => pattern.test(row.crimeType));
    }

    const points = rows.length ? aggregateRows(rows) : [];
    const meta = buildMeta(allRows);

    res.json({
      points,
      meta,
      fallback: false,
    });
  } catch (error) {
    console.error("Failed to build crime heatmap:", error);
    res.status(500).json({ message: "Failed to aggregate crime data", error: error.message });
  }
};

module.exports = {
  getCrimeData,
};
