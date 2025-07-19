const express = require("express");
const multer = require("multer");
const db = require("./db");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const axios = require("axios");
const pdf = require("pdf-parse");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("file"), async (req, res) => {
  const { jenis_korupsi, wilayah, anonim } = req.body;
  const filePath = path.join(__dirname, req.file.path);

  console.log("📄 File diterima:", req.file.originalname);
  console.log("📄 Ukuran:", fs.statSync(filePath).size, "bytes");

  let textContent = "";

  // ✅ Ekstrak isi PDF
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const data = await pdf(fileBuffer);
    textContent = data.text;

    if (!textContent || textContent.length < 30) {
      return res.status(400).send("Isi PDF terlalu pendek atau kosong.");
    }
  } catch (err) {
    console.error("❌ Gagal baca isi PDF:", err.message);
    return res.status(400).send("File PDF tidak dapat diproses.");
  }

  // ✅ Potong teks berdasarkan 2 paragraf pertama
  const paragraphs = textContent
    .split(/\n\s*\n/) // bagi berdasarkan jeda paragraf
    .map(p => p.trim())
    .filter(p => p.length > 30);

  const truncatedText = paragraphs.slice(0, 1).join("\n\n");

  console.log("📤 Mengirim teks ke AI...");
  console.log(truncatedText.slice(0, 100));

  try {
    const aiResponse = await axios.post(
      "http://127.0.0.1:5000/predict",
      { text: truncatedText },
      { timeout: 90000 } // Timeout ditingkatkan jadi 90 detik
    );

    let { label, score } = aiResponse.data;
    score = parseFloat(score);
    let status = label === "korupsi" && score > 0.7 ? "Diproses lanjut" : "Diabaikan";

    // ✅ Logika filter konteks negatif
    const konteksNegatif = [
      "tidak bersalah", "tuduhan palsu", "fitnah", "pencemaran nama baik",
      "hoax", "tidak terbukti", "tidak valid", "bukti palsu"
    ];
    const adaNegasi = konteksNegatif.some(k => textContent.toLowerCase().includes(k));
    if (adaNegasi && label === "korupsi" && score < 0.95) {
      label = "non-korupsi";
      score = 0.2;
      status = "Diabaikan";
    }

    console.log("✅ Respon dari AI:", { label, score, status });

    const sql = `
      INSERT INTO laporan (filename, label, confidence, status, jenis_korupsi, wilayah, anonim)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
      sql,
      [req.file.originalname, label, score, status, jenis_korupsi, wilayah, anonim === "true"],
      (err) => {
        if (err) return res.status(500).send("DB error");
        res.json({ filename: req.file.originalname, label, score, status });
      }
    );
  } catch (error) {
    console.error("❌ Gagal request ke FastAPI:", error.message);
    res.status(500).send("Gagal klasifikasi AI");
  }
});

app.listen(3000, () => {
  console.log("✅ Backend Node.js SIGAP aktif di http://localhost:3000");
});