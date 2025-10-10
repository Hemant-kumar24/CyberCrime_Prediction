import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet } from "react-router-dom";
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween";
import api from "../services/api";
import DashboardSidebar from "../components/DashboardSidebar";
import { mockDashboardData } from "../data/mockDashboardData";
import { useAuth } from "../context/AuthContext";

dayjs.extend(isBetween);

const DATASET_LATEST_DATE = mockDashboardData.incidents
  .map((incident) => dayjs(incident.date))
  .reduce((latest, current) => (current.isAfter(latest) ? current : latest), dayjs(mockDashboardData.incidents[0].date));

const DASHBOARD_LINKS = [
  { label: "Overview", to: "." },
  { label: "Heatmap", to: "heatmap" },
  { label: "Analytics", to: "analytics" },
  { label: "Predictive Analysis", to: "predictive" },
  { label: "Patrol Routes", to: "routes" },
  { label: "Alerts", to: "alerts" },
  { label: "Incidents", to: "incidents" },
  { label: "File a Report", to: "report" },
];

const Dashboard = () => {
  const { user, logout } = useAuth();
  const [data, setData] = useState(mockDashboardData);
  const [error, setError] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [heatmapPoints, setHeatmapPoints] = useState([]);
  const [heatmapMeta, setHeatmapMeta] = useState({ dates: [], crime_types: [] });
  const [heatmapFilters, setHeatmapFilters] = useState({ date: "", crimeType: "" });
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapFallback, setHeatmapFallback] = useState(false);
  const [heatmapInfo, setHeatmapInfo] = useState("");
  const [heatmapError, setHeatmapError] = useState("");
  const [filters, setFilters] = useState({
    type: "all",
    startDate: DATASET_LATEST_DATE.subtract(6, "day").format("YYYY-MM-DD"),
    endDate: DATASET_LATEST_DATE.format("YYYY-MM-DD"),
    severity: "all",
    onlyWomenSafety: false,
  });
  const [layerVisibility, setLayerVisibility] = useState({
    heatmap: true,
    clusters: true,
    patrol: true,
    safe: true,
    womenSafety: false,
  });

  const hydrateDashboard = useCallback(async () => {
    setIsSyncing(true);
    try {
      const response = await api.get("/dashboard");
      setData((prev) => ({
        ...prev,
        metrics: response.data?.metrics ?? prev.metrics,
        alerts: response.data?.alerts ?? prev.alerts,
        clusters: response.data?.clusters ?? prev.clusters,
        hotspots: response.data?.hotspots ?? prev.hotspots,
        incidents: response.data?.incidents ?? prev.incidents,
        predictions: response.data?.predictions ?? prev.predictions,
        patrolRoutes: response.data?.patrolRoutes ?? prev.patrolRoutes,
        safeRoutes: response.data?.safeRoutes ?? prev.safeRoutes,
      }));
      setError("");
    } catch (err) {
      if (err.response?.status === 401) {
        setError("Session expired. Please log in again.");
      } else {
        console.warn("Dashboard sync failed; continuing with cached metrics.", err);
        setError("");
      }
    } finally {
      setIsSyncing(false);
    }
  }, []);

  const localHeatmapMeta = useMemo(() => {
    const dates = Array.from(new Set(data.incidents.map((incident) => incident.date))).sort();
    const crimeTypes = Array.from(new Set(data.incidents.map((incident) => incident.type))).sort();
    return { dates, crime_types: crimeTypes };
  }, [data.incidents]);

  const computeLocalHeatmap = useCallback(
    (filterValues) => {
      const grouped = new Map();
      const filtered = data.incidents.filter((incident) => {
        const matchesDate = !filterValues.date || incident.date === filterValues.date;
        const matchesType =
          !filterValues.crimeType || incident.type.toLowerCase() === filterValues.crimeType.toLowerCase();
        return matchesDate && matchesType;
      });

      filtered.forEach((incident) => {
        const key = `${incident.coordinates[0]}|${incident.coordinates[1]}`;
        const existing = grouped.get(key);
        if (!existing) {
          grouped.set(key, {
            lat: incident.coordinates[0],
            lon: incident.coordinates[1],
            count: 1,
            totalIntensity: incident.density || 1,
            latestDate: incident.date,
            typeCounts: new Map([[incident.type, 1]]),
          });
        } else {
          existing.count += 1;
          existing.totalIntensity += incident.density || 1;
          if (!existing.latestDate || incident.date > existing.latestDate) {
            existing.latestDate = incident.date;
          }
          existing.typeCounts.set(incident.type, (existing.typeCounts.get(incident.type) || 0) + 1);
        }
      });

      const points = Array.from(grouped.values()).map((entry) => {
        const dominantType =
          Array.from(entry.typeCounts.entries()).reduce(
            (best, current) => (current[1] > best[1] ? current : best),
            ["unknown", 0]
          )[0] ?? "Unknown";

        const normalized = entry.totalIntensity / entry.count;
        return {
          lat: entry.lat,
          lon: entry.lon,
          count: entry.count,
          intensity: entry.totalIntensity,
          normalized_count: Math.min(1, Math.max(0, normalized)),
          date: entry.latestDate,
          crime_type: dominantType,
        };
      });

      return {
        points,
        meta: localHeatmapMeta,
      };
    },
    [data.incidents, localHeatmapMeta]
  );

  const fetchHeatmapData = useCallback(
    async (filterValues) => {
      setHeatmapLoading(true);
      try {
        const params = {};
        if (filterValues.date) params.date = filterValues.date;
        if (filterValues.crimeType) params.crime_type = filterValues.crimeType;
        const response = await api.get("/crime-data", { params });
        const points = response.data?.points ?? [];
        setHeatmapPoints(points);
        if (response.data?.meta) {
          setHeatmapMeta(response.data.meta);
        }
        if (response.data?.fallback) {
          setHeatmapFallback(true);
          setHeatmapInfo(response.data.message || "Serving cached Delhi dataset.");
          setHeatmapError("");
        } else {
          setHeatmapFallback(false);
          setHeatmapInfo("");
          setHeatmapError("");
        }
      } catch {
        const fallback = computeLocalHeatmap(filterValues);
        setHeatmapPoints(fallback.points);
        setHeatmapMeta(fallback.meta);
        setHeatmapFallback(true);
        setHeatmapInfo("Analytics service unavailable. Displaying Delhi snapshot data.");
        setHeatmapError("");
      } finally {
        setHeatmapLoading(false);
      }
    },
    [computeLocalHeatmap]
  );

  useEffect(() => {
    hydrateDashboard();
  }, [hydrateDashboard]);

  useEffect(() => {
    setHeatmapMeta(localHeatmapMeta);
  }, [localHeatmapMeta]);

  useEffect(() => {
    fetchHeatmapData(heatmapFilters);
  }, [fetchHeatmapData, heatmapFilters]);

  useEffect(() => {
    if (filters.onlyWomenSafety) {
      setLayerVisibility((prev) => (prev.womenSafety ? prev : { ...prev, womenSafety: true }));
    }
  }, [filters.onlyWomenSafety]);

  const availableTypes = useMemo(() => {
    const types = new Set(data.incidents.map((incident) => incident.type));
    return Array.from(types).sort();
  }, [data.incidents]);

  const filteredIncidents = useMemo(() => {
    const start = dayjs(filters.startDate);
    const end = dayjs(filters.endDate).endOf("day");
    return data.incidents.filter((incident) => {
      const incidentDate = dayjs(incident.date);
      const matchesDate = incidentDate.isBetween(start, end, null, "[]");
      const matchesType = filters.type === "all" || incident.type === filters.type;
      const matchesSeverity = filters.severity === "all" || incident.severity === filters.severity;
      const matchesWomen = !filters.onlyWomenSafety || incident.isWomenSafety;
      return matchesDate && matchesType && matchesSeverity && matchesWomen;
    });
  }, [data.incidents, filters]);

  const handleFilterChange = useCallback((name, value) => {
    setFilters((prev) => ({
      ...prev,
      [name]: value,
    }));
  }, []);

  const handleLayerToggle = useCallback((layerKey) => {
    setLayerVisibility((prev) => ({
      ...prev,
      [layerKey]: !prev[layerKey],
    }));
  }, []);

  const handleHeatmapFilterChange = useCallback((name, value) => {
    setHeatmapFilters((prev) => ({
      ...prev,
      [name]: value,
    }));
  }, []);

  const handleHeatmapReset = useCallback(() => {
    setHeatmapFilters({ date: "", crimeType: "" });
  }, []);

  const refreshHeatmap = useCallback(() => {
    fetchHeatmapData(heatmapFilters);
  }, [fetchHeatmapData, heatmapFilters]);

  const outletContext = useMemo(
    () => ({
      data,
      error,
      isSyncing,
      hydrateDashboard,
      filters,
      handleFilterChange,
      layerVisibility,
      handleLayerToggle,
      availableTypes,
      filteredIncidents,
      heatmapFilters,
      heatmapMeta,
      handleHeatmapFilterChange,
      handleHeatmapReset,
      refreshHeatmap,
      heatmapLoading,
      heatmapPoints,
      heatmapInfo,
      heatmapError,
      heatmapFallback,
    }),
    [
      data,
      error,
      isSyncing,
      hydrateDashboard,
      filters,
      handleFilterChange,
      layerVisibility,
      handleLayerToggle,
      availableTypes,
      filteredIncidents,
      heatmapFilters,
      heatmapMeta,
      handleHeatmapFilterChange,
      handleHeatmapReset,
      refreshHeatmap,
      heatmapLoading,
      heatmapPoints,
      heatmapInfo,
      heatmapError,
      heatmapFallback,
    ]
  );

  return (
    <main className="dashboard dashboard-shell">
      <DashboardSidebar links={DASHBOARD_LINKS} user={user} onLogout={logout} />
      <section className="dashboard-main">
        <header className="dashboard__header">
          <div>
            <h1>Operational Dashboard</h1>
            <p>Track crime hotspots, predictions, and patrol readiness across Delhi jurisdiction.</p>
          </div>
          <div className="dashboard-main__signals">
            {isSyncing ? <span className="dashboard__sync">Syncing latest intelligence...</span> : null}
            {error ? <span className="dashboard__error">{error}</span> : null}
          </div>
        </header>
        <Outlet context={outletContext} />
      </section>
    </main>
  );
};

export default Dashboard;
