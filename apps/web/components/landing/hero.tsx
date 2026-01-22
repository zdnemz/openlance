"use client"

import { Canvas, useFrame } from "@react-three/fiber"
import { Float, Stars } from "@react-three/drei"
import { useRef } from "react"
import { Group } from "three"
import { motion } from "framer-motion"
import { Button } from "@/components/ui/button"

function FloatingShape({ position, color, speed }: { position: [number, number, number]; color: string; speed: number }) {
    const mesh = useRef<Group>(null)

    useFrame((state) => {
        if (!mesh.current) return
        const t = state.clock.getElapsedTime()
        mesh.current.rotation.x = Math.sin(t * speed) * 0.2
        mesh.current.rotation.y = Math.cos(t * speed) * 0.2
        mesh.current.position.y += Math.sin(t * speed * 2) * 0.002
    })

    return (
        <Float speed={speed} rotationIntensity={0.5} floatIntensity={1}>
            <group ref={mesh} position={position}>
                <mesh>
                    <icosahedronGeometry args={[1, 0]} />
                    <meshStandardMaterial color={color} roughness={0.3} metalness={0.8} opacity={0.6} transparent />
                </mesh>
                <mesh scale={[1.01, 1.01, 1.01]}>
                    <icosahedronGeometry args={[1, 0]} />
                    <meshBasicMaterial color={color} wireframe transparent opacity={0.3} />
                </mesh>
            </group>
        </Float>
    )
}

function Scene() {
    return (
        <>
            <ambientLight intensity={0.5} />
            <pointLight position={[10, 10, 10]} intensity={2} color="#8b5cf6" />
            <pointLight position={[-10, -10, -10]} intensity={2} color="#22d3ee" />

            <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />

            <FloatingShape position={[-4, 2, -5]} color="#8b5cf6" speed={1.5} />
            <FloatingShape position={[4, -2, -6]} color="#22d3ee" speed={1.2} />
            {/* Distant shapes */}
            <FloatingShape position={[7, 4, -10]} color="#4f46e5" speed={0.8} />
            <FloatingShape position={[-6, -4, -8]} color="#0d9488" speed={1} />
        </>
    )
}

export function Hero() {
    return (
        <section className="relative h-[110vh] w-full mt-[-80px] overflow-hidden flex items-center justify-center">
            {/* 3D Background */}
            <div className="absolute inset-0 bg-slate-950">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(139,92,246,0.1),transparent_70%)]" />
                <Canvas camera={{ position: [0, 0, 10], fov: 45 }}>
                    <Scene />
                </Canvas>
            </div>

            {/* Content */}
            <div className="relative w-full max-w-7xl px-4 sm:px-6 lg:px-8 z-10 flex flex-col items-center text-center">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                    className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 backdrop-blur-md"
                >
                    <span className="flex h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
                    <span className="text-sm font-medium text-slate-300">OpenLance v1.0 is here</span>
                </motion.div>

                <motion.h1
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
                    className="text-5xl sm:text-7xl lg:text-8xl font-bold tracking-tight text-white mb-8"
                >
                    <span className="block">Hire the World&apos;s</span>
                    <span className="block bg-gradient-to-r from-violet-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent pb-4">
                        Top Technologists
                    </span>
                </motion.h1>

                <motion.p
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.4, ease: "easeOut" }}
                    className="mx-auto max-w-2xl text-lg sm:text-xl text-slate-400 mb-10 leading-relaxed"
                >
                    The premium marketplace for elite software engineers, designers, and product managers.
                    Verified talent, secure escrow payments, and zero hiring friction.
                </motion.p>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.6, ease: "easeOut" }}
                    className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto"
                >
                    <Button size="lg" className="rounded-full shadow-violet-500/25 px-8">
                        Hire Talent
                    </Button>
                    <Button size="lg" variant="glass" className="rounded-full px-8">
                        Find Work
                    </Button>
                </motion.div>

                {/* Stats */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 1, delay: 1 }}
                    className="mt-20 grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-16 border-t border-white/5 pt-10"
                >
                    {[
                        { label: "Total Volume", value: "$2M+" },
                        { label: "Active Contracts", value: "850+" },
                        { label: "Freelancers", value: "1.2k" },
                        { label: "Avg. Rate", value: "$45/hr" },
                    ].map((stat, i) => (
                        <div key={i} className="flex flex-col">
                            <span className="text-2xl font-bold text-white">{stat.value}</span>
                            <span className="text-sm text-slate-500">{stat.label}</span>
                        </div>
                    ))}
                </motion.div>
            </div>

            {/* Scroll indicator */}
            <motion.div
                animate={{ y: [0, 10, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                className="absolute bottom-10 left-1/2 -translate-x-1/2 text-slate-500"
            >
                <div className="h-14 w-8 rounded-full border-2 border-white/10 flex justify-center p-2">
                    <div className="h-2 w-1 bg-cyan-400 rounded-full" />
                </div>
            </motion.div>
        </section>
    )
}
