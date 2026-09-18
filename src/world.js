import * as THREE from '/vendor/three/three.module.js';

// Visual projection only: Starship supplies every position and docking decision.
export class World {
  constructor(container) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020407);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 600);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.append(this.renderer.domElement);
    this.scene.add(new THREE.HemisphereLight(0xd5eaff, 0x33302a, 2));
    const light = new THREE.DirectionalLight(0xffeed4, 4);
    light.position.set(-8, 12, 15);
    this.scene.add(light);
    this.station = new THREE.Group();
    this.scene.add(this.station);
    const metal = new THREE.MeshStandardMaterial({ color: 0xdedbd1, roughness: 0.55, metalness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x233341, roughness: 0.5, metalness: 0.7 });
    const mesh = (geometry, material, parent = this.station) => {
      const object = new THREE.Mesh(geometry, material);
      parent.add(object);
      return object;
    };
    // Twelve simple habitation modules, connected by a ring and radial tubes.
    mesh(new THREE.TorusGeometry(4.5, 0.17, 8, 64), dark).position.z = -2;
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const module = new THREE.Group();
      module.position.set(Math.cos(a) * 4.5, Math.sin(a) * 4.5, -2);
      module.rotation.z = a;
      this.station.add(module);
      mesh(new THREE.BoxGeometry(1.8, 0.9, 1.1), metal, module);
      const panel = mesh(new THREE.BoxGeometry(1.2, 0.55, 0.03), dark, module);
      panel.position.z = 0.57;
      if (i % 3 === 0) {
        const spoke = mesh(new THREE.CylinderGeometry(0.13, 0.13, 4.5, 8), metal);
        spoke.position.set(Math.cos(a) * 2.25, Math.sin(a) * 2.25, -2);
        spoke.rotation.z = a - Math.PI / 2;
      }
    }
    const tube = mesh(new THREE.CylinderGeometry(0.65, 0.65, 3, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x788b96, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.4 }));
    tube.rotation.x = Math.PI / 2;
    tube.position.z = -0.5;
    const lip = mesh(new THREE.TorusGeometry(0.65, 0.07, 10, 48), metal);
    lip.position.z = 1;
    // Mostly faint pinpoints, with fewer medium and bright stars. Generate once
    // so the field remains stable as the cockpit rolls and approaches.
    for (const [count, size, brightness] of [[1150, 0.25, 0.45], [300, 0.55, 0.7], [50, 1.1, 1]]) {
      const stars = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < stars.length; i += 3) {
        const azimuth = Math.random() * Math.PI * 2;
        const z = Math.random() * 2 - 1;
        const r = Math.sqrt(1 - z * z);
        const distance = 180 + Math.random() * 100;
        stars.set([distance * r * Math.cos(azimuth), distance * r * Math.sin(azimuth), distance * z], i);
        const intensity = brightness * (0.55 + Math.random() * 0.45);
        const warm = Math.random() < 0.25;
        colors.set([intensity * (warm ? 1 : 0.85), intensity * 0.93,
          intensity * (warm ? 0.78 : 1)], i);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(stars, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      this.scene.add(new THREE.Points(geometry,
        new THREE.PointsMaterial({ vertexColors: true, size })));
    }
    // A physical guide at the cockpit nose, two units ahead of the camera.
    this.guide = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.006, 6, 64),
      new THREE.MeshBasicMaterial({ color: 0x71ffac, depthTest: false }));
    this.guide.position.z = -2;
    this.guide.renderOrder = 10;
    this.camera.add(this.guide);
    this.scene.add(this.camera);
    this.resize = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / Math.max(1, height);
      this.camera.updateProjectionMatrix();
    });
    this.resize.observe(container);
  }

  render(ship) {
    const roll = THREE.MathUtils.degToRad(ship.angle);
    this.station.rotation.z = THREE.MathUtils.degToRad(ship.targetAngle);
    // Pilot nudges use cockpit axes even while the cockpit is rolling.
    const x = ship.x / 50, y = -ship.y / 50;
    this.camera.position.set(x * Math.cos(roll) - y * Math.sin(roll),
      x * Math.sin(roll) + y * Math.cos(roll), 3 + ship.distance);
    this.camera.rotation.z = roll;
    this.guide.material.color.set(ship.lockReady ? 0xffffff : 0x71ffac);
    this.renderer.render(this.scene, this.camera);
  }
}
