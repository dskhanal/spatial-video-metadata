/* Four-corner planar calibration, independent of the renderer. */
const ProjectionMath = (() => {
  function isConvexQuad(points) {
    if (!Array.isArray(points) || points.length !== 4 ||
        points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v)))) return false;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 0.0001) return false;
      if (sign && Math.sign(cross) !== sign) return false;
      sign = Math.sign(cross);
    }
    // TL, TR, BR, BL must retain their orientation.
    return sign > 0;
  }

  function homography(from, to) {
    if (!isConvexQuad(from) || !isConvexQuad(to)) throw new Error('Keep the four corners in a convex rectangle or trapezoid.');
    const rows = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [u, v] = to[i];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (let col = 0; col < 8; col++) {
      let pivot = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
      if (Math.abs(rows[pivot][col]) < 1e-10) throw new Error('The alignment is too narrow. Move the corners farther apart.');
      [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
      const divisor = rows[col][col];
      for (let c = col; c <= 8; c++) rows[col][c] /= divisor;
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const factor = rows[r][col];
        for (let c = col; c <= 8; c++) rows[r][c] -= factor * rows[col][c];
      }
    }
    return [...rows.map(r => r[8]), 1];
  }

  function transformPoint(matrix, [x, y]) {
    const w = matrix[6] * x + matrix[7] * y + matrix[8];
    if (Math.abs(w) < 1e-10) throw new Error('Point lies on the projection horizon.');
    return [(matrix[0] * x + matrix[1] * y + matrix[2]) / w,
            (matrix[3] * x + matrix[4] * y + matrix[5]) / w];
  }
  return { isConvexQuad, homography, transformPoint };
})();
if (typeof module !== 'undefined') module.exports = ProjectionMath;
