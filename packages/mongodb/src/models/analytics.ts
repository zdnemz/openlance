import mongoose, { Schema, type Document } from 'mongoose';

export enum EventType {
  PAGE_VIEW = 'PAGE_VIEW',
  CLICK = 'CLICK',
  FORM_SUBMIT = 'FORM_SUBMIT',
  ERROR = 'ERROR',
  CUSTOM = 'CUSTOM',
  API_CALL = 'API_CALL'
}

export interface IAnalyticsEvent extends Document {
  eventType: EventType;
  eventName: string;
  userId?: string;
  anonymousId?: string;
  properties: Record<string, unknown>;
  url: string;
  referrer?: string;
  userAgent?: string;
  ip?: string;
  timestamp: Date;
}

const AnalyticsEventSchema: Schema = new Schema({
  eventType: { type: String, enum: Object.values(EventType), required: true },
  eventName: { type: String, required: true, index: true },
  userId: { type: String, index: true },
  anonymousId: { type: String, index: true },
  properties: { type: Schema.Types.Mixed, default: {} },
  url: { type: String, required: true },
  referrer: { type: String },
  userAgent: { type: String },
  ip: { type: String },
  timestamp: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

// Optimize for time-series queries
AnalyticsEventSchema.index({ timestamp: -1, eventType: 1 });

export const AnalyticsEvent = mongoose.models.AnalyticsEvent || mongoose.model<IAnalyticsEvent>('AnalyticsEvent', AnalyticsEventSchema);

export interface IUserSession extends Document {
  userId?: string;
  anonymousId: string;
  startTime: Date;
  endTime?: Date;
  duration?: number; // in seconds
  deviceType: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  os?: string;
  browser?: string;
  location?: {
    country?: string;
    city?: string;
    region?: string;
  };
  entryPage: string;
  exitPage?: string;
  pageViews: number;
}

const UserSessionSchema: Schema = new Schema({
  userId: { type: String, index: true },
  anonymousId: { type: String, required: true, index: true },
  startTime: { type: Date, default: Date.now, required: true },
  endTime: { type: Date },
  duration: { type: Number },
  deviceType: { type: String, enum: ['mobile', 'tablet', 'desktop', 'unknown'], default: 'unknown' },
  os: { type: String },
  browser: { type: String },
  location: {
    country: String,
    city: String,
    region: String
  },
  entryPage: { type: String, required: true },
  exitPage: { type: String },
  pageViews: { type: Number, default: 0 }
}, { timestamps: true });

export const UserSession = mongoose.models.UserSession || mongoose.model<IUserSession>('UserSession', UserSessionSchema);

export interface IPageMetric extends Document {
  url: string;
  loadTime: number; // ms
  ttfb: number; // Time to First Byte
  fcp: number; // First Contentful Paint
  lcp: number; // Largest Contentful Paint
  cls: number; // Cumulative Layout Shift
  fid: number; // First Input Delay
  timestamp: Date;
}

const PageMetricSchema: Schema = new Schema({
  url: { type: String, required: true, index: true },
  loadTime: { type: Number },
  ttfb: { type: Number },
  fcp: { type: Number },
  lcp: { type: Number },
  cls: { type: Number },
  fid: { type: Number },
  timestamp: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

export const PageMetric = mongoose.models.PageMetric || mongoose.model<IPageMetric>('PageMetric', PageMetricSchema);
