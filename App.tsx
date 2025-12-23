
import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { GameState, FeedbackText } from './types';
import { soundManager } from './utils/SoundManager';
// Added missing imports for RENDER_FPS and FEEDBACK_DURATION
import { MAX_DISCS, DETECTION_FPS, TRIGGER_THRESHOLD, AIM_ASSIST_STRENGTH, RENDER_FPS, FEEDBACK_DURATION } from './constants';

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(GameState.LOADING);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [feedbackTexts, setFeedbackTexts] = useState<FeedbackText[]>([]);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const handsRef = useRef<any>(null);
  const cameraUtilRef = useRef<any>(null);

  // Game specific refs
  const discsRef = useRef<THREE.Mesh[]>([]);
  const laserRef = useRef<THREE.Line | null>(null);
  const crosshairRef = useRef<THREE.Group | null>(null);
  const lastTriggerState = useRef<boolean>(false);
  const debounceRef = useRef<number>(0);
  const scoreRef = useRef<number>(0);

  // Decoupled state for hand data
  const handData = useRef<{
    active: boolean;
    aimPos: THREE.Vector3;
    aimDir: THREE.Vector3;
    triggerVal: number;
    screenPos: { x: number; y: number };
  }>({
    active: false,
    aimPos: new THREE.Vector3(),
    aimDir: new THREE.Vector3(0, 0, -1),
    triggerVal: 1,
    screenPos: { x: 0.5, y: 0.5 }
  });

  const initThree = useCallback(() => {
    if (!containerRef.current) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.z = 5;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    containerRef.current.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 5, 5);
    scene.add(directionalLight);

    // Laser
    const laserMat = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.5 });
    const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-10)]);
    const laser = new THREE.Line(laserGeo, laserMat);
    scene.add(laser);
    laserRef.current = laser;

    // Crosshair Group
    const crosshair = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(0.08, 0.1, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    crosshair.add(ring);
    scene.add(crosshair);
    crosshairRef.current = crosshair;

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
  }, []);

  const spawnDisc = useCallback(() => {
    if (!sceneRef.current) return;
    const geo = new THREE.TorusGeometry(0.3, 0.05, 16, 100);
    const mat = new THREE.MeshPhongMaterial({ 
      color: 0xff00ff, 
      emissive: 0x330033, 
      specular: 0x444444, 
      shininess: 30 
    });
    const disc = new THREE.Mesh(geo, mat);
    
    // Spawn at edges
    const side = Math.floor(Math.random() * 4);
    if (side === 0) { // top
      disc.position.set((Math.random() - 0.5) * 10, 5, -5);
    } else if (side === 1) { // bottom
      disc.position.set((Math.random() - 0.5) * 10, -5, -5);
    } else if (side === 2) { // left
      disc.position.set(-8, (Math.random() - 0.5) * 6, -5);
    } else { // right
      disc.position.set(8, (Math.random() - 0.5) * 6, -5);
    }
    
    // Custom properties for motion
    (disc as any).velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 0.05,
      (Math.random() - 0.5) * 0.05,
      Math.random() * 0.02
    ).add(new THREE.Vector3(0, 0, 0.01));
    
    (disc as any).targetPos = new THREE.Vector3(0, 0, -5);
    
    sceneRef.current.add(disc);
    discsRef.current.push(disc);
  }, []);

  const initMediaPipe = useCallback(async () => {
    try {
      const Hands = (window as any).Hands;
      const Camera = (window as any).Camera;

      if (!Hands || !Camera) {
        throw new Error("MediaPipe libraries not loaded correctly from unpkg.");
      }

      const hands = new Hands({
        locateFile: (file: string) => `https://unpkg.com/@mediapipe/hands@0.4.1646424915/${file}`,
      });

      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7,
      });

      hands.onResults((results: any) => {
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
          const landmarks = results.multiHandLandmarks[0];
          
          // Index Finger Tip (8) and Base (5)
          const indexTip = landmarks[8];
          const indexBase = landmarks[5];
          const thumbTip = landmarks[4];
          
          // Screen coordinate space (0-1) to Three.js (-1 to 1)
          const x = (indexTip.x - 0.5) * 2;
          const y = -(indexTip.y - 0.5) * 2;
          
          // Calculate Aim Vector
          const dir = new THREE.Vector3(
            indexTip.x - indexBase.x,
            -(indexTip.y - indexBase.y),
            -(indexTip.z - indexBase.z)
          ).normalize();

          // Calculate Trigger (Distance between Thumb Tip and Index Base)
          const dx = thumbTip.x - indexBase.x;
          const dy = thumbTip.y - indexBase.y;
          const dz = thumbTip.z - indexBase.z;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

          handData.current = {
            active: true,
            aimPos: new THREE.Vector3(x * 5, y * 5, 0),
            aimDir: dir,
            triggerVal: dist,
            screenPos: { x: indexTip.x, y: indexTip.y }
          };
        } else {
          handData.current.active = false;
        }
      });

      if (videoRef.current) {
        const camera = new Camera(videoRef.current, {
          onFrame: async () => {
            // Throttled detection
            // Fix: RENDER_FPS is now correctly imported
            if (Math.random() > (DETECTION_FPS / RENDER_FPS)) return; 
            await hands.send({ image: videoRef.current! });
          },
          width: 1280,
          height: 720,
        });
        camera.start();
        cameraUtilRef.current = camera;
      }

      handsRef.current = hands;
      setGameState(GameState.PLAYING);
      soundManager.init();
    } catch (err) {
      console.error(err);
      setGameState(GameState.ERROR);
      setErrorMessage(err instanceof Error ? err.message : "Failed to initialize gesture engine.");
    }
  }, []);

  const shoot = useCallback(() => {
    if (!sceneRef.current || !cameraRef.current) return;
    
    // Raycasting
    const raycaster = new THREE.Raycaster();
    raycaster.set(handData.current.aimPos, handData.current.aimDir);

    let hit = false;
    const intersects = raycaster.intersectObjects(discsRef.current);

    if (intersects.length > 0) {
      const object = intersects[0].object as THREE.Mesh;
      // Remove disc
      sceneRef.current.remove(object);
      discsRef.current = discsRef.current.filter(d => d !== object);
      
      // Feedback
      hit = true;
      scoreRef.current += 100;
      soundManager.playHit();
      addFeedbackText("HIT", handData.current.screenPos);
      
      // Respawn
      spawnDisc();

      // Screen shake
      if (rendererRef.current) {
        const dom = rendererRef.current.domElement;
        dom.style.transform = `translate(${(Math.random()-0.5)*10}px, ${(Math.random()-0.5)*10}px)`;
        setTimeout(() => dom.style.transform = 'translate(0,0)', 50);
      }
    }

    if (!hit) {
      soundManager.playMiss();
      addFeedbackText("MISS", handData.current.screenPos);
    }
  }, [spawnDisc]);

  const addFeedbackText = (text: string, pos: {x: number, y: number}) => {
    const id = Date.now();
    setFeedbackTexts(prev => [...prev, {
      id,
      text,
      type: text === "HIT" ? "HIT" : "MISS",
      x: pos.x * window.innerWidth,
      y: pos.y * window.innerHeight,
      // Fix: FEEDBACK_DURATION is now correctly imported
      life: FEEDBACK_DURATION
    }]);
  };

  useEffect(() => {
    initThree();
    initMediaPipe();

    // Start rendering loop
    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);

      if (gameState === GameState.PLAYING && sceneRef.current && cameraRef.current && rendererRef.current) {
        
        // Ensure exact 4 discs
        while (discsRef.current.length < MAX_DISCS) {
          spawnDisc();
        }

        // Update Discs
        discsRef.current.forEach(disc => {
          const d = disc as any;
          // Move toward center
          const toCenter = d.targetPos.clone().sub(disc.position).normalize().multiplyScalar(0.01);
          d.velocity.add(toCenter);
          disc.position.add(d.velocity);
          disc.rotation.x += 0.05;
          disc.rotation.y += 0.02;

          // If too close or far, reset
          if (disc.position.length() > 15 || disc.position.z > 2) {
             sceneRef.current?.remove(disc);
             discsRef.current = discsRef.current.filter(x => x !== disc);
          }
        });

        // Update Laser & Crosshair
        if (handData.current.active && laserRef.current && crosshairRef.current) {
          laserRef.current.visible = true;
          crosshairRef.current.visible = true;

          const start = handData.current.aimPos;
          const end = start.clone().add(handData.current.aimDir.clone().multiplyScalar(20));
          
          const positions = laserRef.current.geometry.attributes.position.array as Float32Array;
          positions[0] = start.x; positions[1] = start.y; positions[2] = start.z;
          positions[3] = end.x;   positions[4] = end.y;   positions[5] = end.z;
          laserRef.current.geometry.attributes.position.needsUpdate = true;

          // Magnetic Aim Assist
          let targetPoint = end;
          let minAngle = Infinity;
          discsRef.current.forEach(disc => {
            const vecToDisc = disc.position.clone().sub(start).normalize();
            const angle = handData.current.aimDir.angleTo(vecToDisc);
            if (angle < 0.25 && angle < minAngle) {
              minAngle = angle;
              const lerpFactor = 1 - (angle / 0.25);
              targetPoint.lerp(disc.position, lerpFactor * AIM_ASSIST_STRENGTH);
            }
          });

          crosshairRef.current.position.copy(targetPoint);
          crosshairRef.current.lookAt(start);

          // Handle Trigger
          const isTriggered = handData.current.triggerVal < TRIGGER_THRESHOLD;
          if (isTriggered && !lastTriggerState.current && Date.now() > debounceRef.current) {
             shoot();
             debounceRef.current = Date.now() + 250;
          }
          lastTriggerState.current = isTriggered;

          // Visual Feedback on trigger
          (crosshairRef.current.children[0] as THREE.Mesh).scale.setScalar(isTriggered ? 0.8 : 1);
        } else {
          if (laserRef.current) laserRef.current.visible = false;
          if (crosshairRef.current) crosshairRef.current.visible = false;
        }

        // Update Feedback Text Lifespans
        setFeedbackTexts(prev => {
          const updated = prev.map(f => ({ ...f, life: f.life - 1, y: f.y - 1 }));
          return updated.filter(f => f.life > 0);
        });

        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    const handleResize = () => {
      if (cameraRef.current && rendererRef.current) {
        const width = window.innerWidth;
        const height = window.innerHeight;
        cameraRef.current.aspect = width / height;
        cameraRef.current.updateProjectionMatrix();
        rendererRef.current.setSize(width, height);
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleResize);
    };
  }, [gameState, initMediaPipe, initThree, shoot, spawnDisc]);

  return (
    <div className="w-full h-full relative" ref={containerRef}>
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover opacity-30 pointer-events-none" autoPlay playsInline muted />
      
      {/* HUD */}
      {gameState === GameState.PLAYING && (
        <div className="absolute top-8 left-8 text-cyan-400 font-mono text-2xl z-20 pointer-events-none">
          SCORE: {scoreRef.current.toString().padStart(6, '0')}
        </div>
      )}

      {/* Floating Feedback */}
      {feedbackTexts.map(f => (
        <div 
          key={f.id}
          className={`absolute font-bold text-xl pointer-events-none transition-opacity duration-300 z-30 ${f.type === 'HIT' ? 'text-green-400' : 'text-red-500'}`}
          style={{ 
            left: f.x, 
            top: f.y, 
            // Fix: FEEDBACK_DURATION is now correctly imported
            opacity: f.life / FEEDBACK_DURATION,
            transform: 'translate(-50%, -50%)' 
          }}
        >
          {f.text}
        </div>
      ))}

      {/* Loading Overlay */}
      {gameState === GameState.LOADING && (
        <div className="fixed inset-0 bg-black flex flex-col items-center justify-center z-50">
          <div className="w-16 h-16 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-cyan-500 font-mono text-xl tracking-widest animate-pulse">LOADING GESTURE ENGINE...</p>
          <p className="text-gray-500 text-sm mt-4">Ensuring MediaPipe v0.4.1646424915 integrity</p>
        </div>
      )}

      {/* Error Overlay */}
      {gameState === GameState.ERROR && (
        <div className="fixed inset-0 bg-black/90 flex flex-col items-center justify-center z-50 text-center p-8">
          <div className="text-red-500 text-6xl mb-4">⚠️</div>
          <h2 className="text-white text-2xl font-bold mb-2">INITIALIZATION FAILED</h2>
          <p className="text-red-400 font-mono mb-6">{errorMessage}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg transition-colors"
          >
            RETRY
          </button>
        </div>
      )}

      {/* Instructions Overlay */}
      {gameState === GameState.PLAYING && scoreRef.current === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/20">
          <div className="bg-black/60 p-8 rounded-2xl border border-cyan-500/30 text-center max-w-md">
            <h3 className="text-cyan-400 text-xl font-bold mb-4">HOW TO PLAY</h3>
            <ul className="text-gray-200 text-left space-y-2 mb-6">
              <li>☝️ <span className="text-cyan-400 font-bold">AIM:</span> Point your index finger at the screen.</li>
              <li>👍 <span className="text-cyan-400 font-bold">FIRE:</span> Pull your thumb down towards your hand.</li>
              <li>🎯 <span className="text-cyan-400 font-bold">HINT:</span> Magnetic aim assist helps when you're close!</li>
            </ul>
            <p className="text-xs text-gray-400 italic">Position yourself 3-5 feet from the camera.</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
