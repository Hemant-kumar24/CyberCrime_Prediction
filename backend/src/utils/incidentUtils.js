const womenSafetyKeywords = ["harassment", "assault", "stalking", "eve", "molestation", "women", "girl"];

const normaliseCrimeType = (value = "") => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "general" || lower === "unknown" || lower === "na") {
    return "";
  }
  return trimmed;
};

const severityFromIntensity = (intensity = 0.6) => {
  if (intensity >= 0.85) return "high";
  if (intensity >= 0.45) return "medium";
  return "low";
};

const isWomenSafetyType = (crimeType = "", row = {}) => {
  const lowerType = (crimeType || "").toLowerCase();
  if (womenSafetyKeywords.some((keyword) => lowerType.includes(keyword))) {
    return true;
  }
  const category = String(row.category || row.offence || row.notes || "").toLowerCase();
  if (womenSafetyKeywords.some((keyword) => category.includes(keyword))) {
    return true;
  }
  const womenFlag = String(
    row.is_women_safety ?? row.iswomensafety ?? row.womensafety ?? row.women_safety ?? ""
  ).toLowerCase();
  return womenFlag === "true" || womenFlag === "yes" || womenFlag === "1";
};

module.exports = {
  normaliseCrimeType,
  severityFromIntensity,
  isWomenSafetyType,
};
