const { spawn } = require("child_process");
const path = require("path");
const Incident = require("../models/Incident");
const {
  exportIncidentsToCsv,
  severityFromIntensity,
  buildLocation,
  purgeGeneralIncidents,
  seedIncidentsFromCsv,
} = require("../services/incidentService");

const PYTHON_DIR = path.join(__dirname, "..", "..", "python");
const FORECAST_SCRIPT = path.join(PYTHON_DIR, "forecast_crime.py");

const loadCrimeEntries = async () => {
  await seedIncidentsFromCsv();
  await purgeGeneralIncidents();
  const incidents = await Incident.find({}).sort({ date: 1 }).lean();

  return incidents
    .map((doc) => {
      if (!doc.crimeType || /^general$/i.test(doc.crimeType)) return null;
      const date = doc.date ? new Date(doc.date) : null;
      if (!date || Number.isNaN(date.getTime())) return null;
      const intensityParsed = Number.parseFloat(doc.intensity);
      const intensity = Number.isFinite(intensityParsed) ? intensityParsed : 0.6;
      const lat = doc.latitude != null ? Number(doc.latitude) : null;
      const lon = doc.longitude != null ? Number(doc.longitude) : null;

      return {
        id: String(doc._id),
        city: doc.city || "Unknown",
        area: doc.area || "Unknown Area",
        location: doc.location || buildLocation(doc.area || "Unknown Area", doc.city || "Unknown"),
        crimeType: doc.crimeType,
        date,
        dateISO: date.toISOString().slice(0, 10),
        lat: lat != null ? Number(lat.toFixed(6)) : null,
        lon: lon != null ? Number(lon.toFixed(6)) : null,
        intensity,
        severity: doc.severity || severityFromIntensity(intensity),
        description: doc.description || `Reported ${doc.crimeType} incident in ${doc.area || "the area"}.`,
        isWomenSafety: Boolean(doc.isWomenSafety),
      };
    })
    .filter((entry) => entry && entry.crimeType)
    .sort((a, b) => a.date - b.date);
};

const computeHotspotsAndClusters = (entries) => {
  const grouped = new Map();

  entries.forEach((entry) => {
    const key = `${entry.area}|${entry.city}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        area: entry.area,
        city: entry.city,
        count: 0,
        intensityTotal: 0,
        latSum: 0,
        lonSum: 0,
        coordinates: 0,
        latestDate: entry.date,
        typeCounts: new Map(),
      });
    }
    const record = grouped.get(key);
    record.count += 1;
    record.intensityTotal += entry.intensity;
    if (entry.lat != null && entry.lon != null) {
      record.latSum += entry.lat;
      record.lonSum += entry.lon;
      record.coordinates += 1;
    }
    if (entry.date > record.latestDate) {
      record.latestDate = entry.date;
    }
    const typeKey = entry.crimeType || "General";
    record.typeCounts.set(typeKey, (record.typeCounts.get(typeKey) || 0) + 1);
  });

  const aggregations = Array.from(grouped.values()).map((record) => {
    const dominantType =
      Array.from(record.typeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "General";
    const avgIntensity = record.intensityTotal / Math.max(record.count, 1);
    return {
      area: record.area,
      city: record.city,
      count: record.count,
      avgIntensity,
      dominantType,
      lat: record.coordinates ? record.latSum / record.coordinates : null,
      lon: record.coordinates ? record.lonSum / record.coordinates : null,
      latestDate: record.latestDate,
    };
  });

  const maxCount = aggregations.reduce((acc, item) => Math.max(acc, item.count), 0) || 1;
  const hotspots = aggregations
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((item, index) => ({
      id: `HS-${index + 1}`,
      name: `${item.area}${item.city && item.city !== "Unknown" ? `, ${item.city}` : ""}`,
      confidence: Number((item.count / maxCount).toFixed(2)),
      dominantType: item.dominantType,
    }));

  const clusters = aggregations
    .filter((item) => item.lat != null && item.lon != null)
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.min(6, aggregations.length))
    .map((item, index) => ({
      id: `CL-${index + 1}`,
      label: `${item.area}${item.city && item.city !== "Unknown" ? `, ${item.city}` : ""}`,
      center: [Number(item.lat.toFixed(4)), Number(item.lon.toFixed(4))],
      radius: Number((0.45 + Math.min(item.avgIntensity, 1.2) * 0.35).toFixed(2)),
      score: Number((item.count / maxCount).toFixed(2)),
      primaryType: item.dominantType,
    }));

  return { hotspots, clusters };
};

const computeMetrics = (entries, hotspots) => {
  const total = entries.length;
  if (!total) {
    return {
      totalIncidents: 0,
      weeklyTrend: 0,
      hotspotsTracked: 0,
      patrolRoutesSuggested: 0,
      responseTimeImprovement: 0,
    };
  }

  const latestDate = entries[entries.length - 1].date;
  const lastWeekStart = new Date(latestDate);
  lastWeekStart.setDate(lastWeekStart.getDate() - 6);

  const previousWeekStart = new Date(lastWeekStart);
  previousWeekStart.setDate(previousWeekStart.getDate() - 7);

  const lastWeekCount = entries.filter((entry) => entry.date >= lastWeekStart && entry.date <= latestDate).length;
  const previousWeekCount = entries.filter(
    (entry) => entry.date >= previousWeekStart && entry.date < lastWeekStart
  ).length;

  let weeklyTrend =
    previousWeekCount > 0
      ? ((lastWeekCount - previousWeekCount) / Math.max(previousWeekCount, 1)) * 100
      : lastWeekCount > 0
        ? 100
        : 0;
  weeklyTrend = Number(weeklyTrend.toFixed(1));

  const averageIntensity =
    entries.reduce((acc, entry) => acc + entry.intensity, 0) / Math.max(entries.length, 1);
  const responseTimeImprovement = Math.max(
    5,
    Math.min(40, Math.round((1.6 - averageIntensity) * 22 + 14))
  );

  return {
    totalIncidents: total,
    weeklyTrend,
    hotspotsTracked: hotspots.length,
    patrolRoutesSuggested: Math.max(3, Math.min(10, Math.round(hotspots.length * 0.75) || 3)),
    responseTimeImprovement,
  };
};

const computePredictions = (entries) => {
  if (!entries.length) {
    return { nextWeek: [], byType: [] };
  }

  const latestDate = entries[entries.length - 1].date;
  const countsByDate = new Map();

  entries.forEach((entry) => {
    countsByDate.set(entry.dateISO, (countsByDate.get(entry.dateISO) || 0) + 1);
  });

  const sortedDates = Array.from(countsByDate.keys()).sort();
  const recentDates = sortedDates.slice(-7);
  const averageRecent =
    recentDates.length > 0
      ? recentDates.reduce((acc, iso) => acc + countsByDate.get(iso), 0) / recentDates.length
      : entries.length / Math.max(sortedDates.length, 1);
  const baseAverage = Math.max(1, Math.round(averageRecent || 1));

  const nextWeek = Array.from({ length: 7 }).map((_, index) => {
    const futureDate = new Date(latestDate);
    futureDate.setDate(futureDate.getDate() + index + 1);
    const iso = futureDate.toISOString().slice(0, 10);
    const seasonalAdjustment = 1 + Math.sin(index / 2) * 0.05;
    const incidents = Math.max(1, Math.round(baseAverage * seasonalAdjustment));
    return { date: iso, incidents };
  });

  const byTypeMap = new Map();
  entries.forEach((entry) => {
    const key = entry.crimeType || "General";
    byTypeMap.set(key, (byTypeMap.get(key) || 0) + 1);
  });

  const byType = Array.from(byTypeMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, value]) => ({ type, value }));

  return { nextWeek, byType };
};

const buildAlerts = (hotspots, latestDate) => {
  if (!hotspots.length) return [];
  const baseTimestamp = latestDate ? latestDate.toISOString() : new Date().toISOString();

  return hotspots.slice(0, 3).map((spot, index) => ({
    id: `ALERT-${index + 1}`,
    message: `Elevated ${spot.dominantType} reports near ${spot.name}. Prioritise patrol visibility.`,
    severity: index === 0 ? "high" : "medium",
    timestamp: baseTimestamp,
  }));
};

const buildIncidentList = (entries) =>
  entries
    .filter((entry) => entry.lat != null && entry.lon != null)
    .sort((a, b) => b.date - a.date)
    .slice(0, 250)
    .map((entry) => ({
      id: entry.id,
      type: entry.crimeType,
      date: entry.dateISO,
      coordinates: [entry.lat, entry.lon],
      severity: entry.severity,
      density: Number(entry.intensity.toFixed(2)),
      location: entry.location,
      description: entry.description,
      isWomenSafety: entry.isWomenSafety,
    }));

const dashboardOverview = async (_req, res) => {
  try {
    const entries = await loadCrimeEntries();

    if (!entries.length) {
      res.json({
        metrics: {
          totalIncidents: 0,
          weeklyTrend: 0,
          hotspotsTracked: 0,
          patrolRoutesSuggested: 0,
          responseTimeImprovement: 0,
        },
        clusters: [],
        hotspots: [],
        alerts: [],
        incidents: [],
        predictions: { nextWeek: [], byType: [] },
        fallback: true,
        message: "No incidents recorded in the dataset.",
      });
      return;
    }

    const { hotspots, clusters } = computeHotspotsAndClusters(entries);
    const metrics = computeMetrics(entries, hotspots);
    const predictions = computePredictions(entries);
    const alerts = buildAlerts(hotspots, entries[entries.length - 1].date);
    const incidents = buildIncidentList(entries);

    res.json({
      metrics,
      hotspots,
      clusters,
      alerts,
      incidents,
      predictions,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Dashboard overview generation failed:", error);
    res.json({
      metrics: {
        totalIncidents: 0,
        weeklyTrend: 0,
        hotspotsTracked: 0,
        patrolRoutesSuggested: 0,
        responseTimeImprovement: 0,
      },
      clusters: [],
      hotspots: [],
      alerts: [],
      incidents: [],
      predictions: { nextWeek: [], byType: [] },
      fallback: true,
      message: "Dashboard metrics unavailable; using fallback values.",
    });
  }
};

const pythonCandidates = [
  process.env.PYTHON_PATH,
  process.platform === "win32" ? "python" : "python3",
  process.platform === "win32" ? "py" : null,
].filter(Boolean);

const runForecastProcess = () =>
  new Promise((resolve, reject) => {
    const args = [FORECAST_SCRIPT];

    const attempt = (index = 0) => {
      if (index >= pythonCandidates.length) {
        reject(new Error("No python executable available for Prophet forecast"));
        return;
      }

      const command = pythonCandidates[index];
      const child = spawn(command, args, {
        cwd: PYTHON_DIR,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        if (error.code === "ENOENT") {
          attempt(index + 1);
        } else {
          reject(error);
        }
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `Prophet script exited with code ${code}`));
        } else {
          resolve(stdout);
        }
      });
    };

    attempt();
  });

const parseCsvDataset = async () => {
  const entries = await loadCrimeEntries();
  return entries
    .filter((entry) => entry.lat != null && entry.lon != null)
    .map((entry) => ({
    city: entry.city,
    area: entry.area,
    date: entry.date,
    lat: entry.lat,
    lon: entry.lon,
  }));
};

const buildFallbackForecast = async () => {
  const entries = await parseCsvDataset();
  const byArea = new Map();

  entries.forEach(({ city, area, date, lat, lon }) => {
    const key = `${city}::${area}`;
    if (!byArea.has(key)) {
      byArea.set(key, {
        key,
        city,
        area,
        latitudes: lat != null ? [lat] : [],
        longitudes: lon != null ? [lon] : [],
        historyMap: new Map(),
      });
    }

    const record = byArea.get(key);
    const dayKey = date.toISOString().slice(0, 10);
    record.historyMap.set(dayKey, (record.historyMap.get(dayKey) || 0) + 1);
    if (lat != null) record.latitudes.push(lat);
    if (lon != null) record.longitudes.push(lon);
  });

  const horizonDays = 7;
  const areas = Array.from(byArea.values())
    .map((record) => {
      const history = Array.from(record.historyMap.entries())
        .map(([day, count]) => ({ date: day, count }))
        .sort((a, b) => (a.date > b.date ? 1 : -1));

      const lastDate = history.length ? new Date(history[history.length - 1].date) : new Date();
      const recentCounts = history.slice(-14).map((item) => item.count);
      const average = recentCounts.length
        ? recentCounts.reduce((acc, value) => acc + value, 0) / recentCounts.length
        : 0;

      const forecast = Array.from({ length: horizonDays }).map((_, index) => {
        const day = new Date(lastDate);
        day.setDate(day.getDate() + index + 1);
        const isoDate = day.toISOString().slice(0, 10);
        return {
          date: isoDate,
          prediction: Number(average.toFixed(3)),
          lower: Number(Math.max(0, average * 0.85).toFixed(3)),
          upper: Number((average * 1.15).toFixed(3)),
        };
      });

      const latitudes = record.latitudes.filter((value) => Number.isFinite(value));
      const longitudes = record.longitudes.filter((value) => Number.isFinite(value));

      return {
        key: record.key,
        city: record.city,
        area: record.area,
        lat: latitudes.length ? latitudes.reduce((acc, value) => acc + value, 0) / latitudes.length : null,
        lon: longitudes.length ? longitudes.reduce((acc, value) => acc + value, 0) / longitudes.length : null,
        history,
        forecast,
        next_week_total: Number(forecast.reduce((acc, item) => acc + item.prediction, 0).toFixed(3)),
      };
    })
    .sort((a, b) => b.next_week_total - a.next_week_total)
    .slice(0, 6);

  return {
    generated_at: new Date().toISOString(),
    fallback: true,
    areas,
    summary: {
      total_areas: areas.length,
      horizon_days: horizonDays,
      message: "Prophet forecast unavailable; returned averaged projections.",
    },
  };
};

const predictiveAnalysis = async (_req, res) => {
  try {
    await exportIncidentsToCsv();
    const output = await runForecastProcess();
    const payload = JSON.parse(output || "{}");
    res.json(payload);
  } catch (error) {
    console.warn("Prophet forecast generation failed:", error.message);
    try {
      const fallback = await buildFallbackForecast();
      res.json(fallback);
    } catch (fallbackError) {
      console.error("Predictive fallback failed:", fallbackError.message);
      res.status(500).json({
        message: "Unable to compute predictive analysis",
        error: fallbackError.message,
      });
    }
  }
};

module.exports = {
  dashboardOverview,
  predictiveAnalysis,
};
