import mongoose from 'mongoose'

declare global {
  // eslint-disable-next-line no-var
  var mongoConnection: typeof mongoose | undefined
}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/openlance'

export async function connectMongoDB(): Promise<typeof mongoose> {
  if (globalThis.mongoConnection) {
    return globalThis.mongoConnection
  }

  try {
    const connection = await mongoose.connect(MONGODB_URI)
    globalThis.mongoConnection = connection
    console.warn('MongoDB connected successfully')
    return connection
  } catch (error) {
    console.error('MongoDB connection error:', error)
    throw error
  }
}

export async function disconnectMongoDB(): Promise<void> {
  if (globalThis.mongoConnection) {
    await mongoose.disconnect()
    globalThis.mongoConnection = undefined
  }
}

export { mongoose }
export default mongoose
