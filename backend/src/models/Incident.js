const mongoose = require("mongoose");

const IncidentSchema = new mongoose.Schema(
  {
    city: { type: String, default: "Unknown" },
    district: { type: String },
    zone: { type: String },
    street: { type: String },
    colony: { type: String },
    area: { type: String, required: true },
    location: { type: String },
    crimeType: { type: String, required: true },
    description: { type: String },
    victimAge: { type: Number },
    gender: { type: String },
    date: { type: Date, required: true },
    time: { type: String },
    intensity: { type: Number, default: 0.6 },
    severity: { type: String, enum: ["low", "medium", "high"], default: "low" },
    isWomenSafety: { type: Boolean, default: false },
    latitude: { type: Number },
    longitude: { type: Number },
    source: { type: String, default: "manual" },
  },
  {
    timestamps: true,
  }
);

IncidentSchema.index({ date: 1 });
IncidentSchema.index({ crimeType: 1 });
IncidentSchema.index({ area: 1 });
IncidentSchema.index({ latitude: 1, longitude: 1 });

module.exports = mongoose.model("Incident", IncidentSchema);
