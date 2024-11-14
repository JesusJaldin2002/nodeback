require("dotenv").config();
const express = require("express");
const axios = require("axios");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const { Pool } = require("pg"); // Importar la librería de PostgreSQL

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

app.use(express.json());

// Endpoint para generar el PDF
app.post("/api/generate-chatgpt-pdf", async (req, res) => {
  const { data } = req.body;

  if (!data) {
    return res.status(400).json({ error: "No se proporcionaron datos" });
  }

  try {
    // Generar el prompt para OpenAI
    const prompt = `
        A partir de estos datos de una historia clínica:
        ${JSON.stringify(data)}
        
        Genera un resumen detallado en formato de texto con el siguiente formato para un PDF titulado "HISTORIA CLÍNICA DIGITALIZADA":
        1. Todos los títulos deben estar en negrita usando ** para denotar negrita.
        2. Usa encabezados claros con una breve descripción, si es necesario, añade saltos de linea entre los encabezados y el contenido.
        3. Muestra la información en listas ordenadas o con viñetas según corresponda.
        4. Solo presenta información relevante y estructurada; no incluyas texto adicional ni explicaciones no solicitadas.
      `;

    const chatResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.CHATGPT_API_KEY}`,
        },
      }
    );

    const generatedText = chatResponse.data.choices[0].message.content;
    console.log("Texto generado por ChatGPT:", generatedText); // Depuración

    // Crear el PDF
    const doc = new PDFDocument({
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
    });
    const filename = `chatgpt_generated_${uuidv4()}.pdf`;
    const filepath = path.join(__dirname, "pdfs", filename);

    if (!fs.existsSync(path.join(__dirname, "pdfs"))) {
      fs.mkdirSync(path.join(__dirname, "pdfs"));
    }

    const writeStream = fs.createWriteStream(filepath);
    doc.pipe(writeStream);

    // Escribir contenido al PDF
    const lines = generatedText.split("\n");
    lines.forEach((line, index) => {
      if (index === 0 && line.trim() !== "") {
        // Hacer que el título principal sea más grande y en azul
        doc
          .fontSize(26)
          .font("Helvetica-Bold")
          .fillColor("blue")
          .text(line.replace(/\*\*/g, "").trim(), { align: "center" })
          .moveDown(1);
        doc.fillColor("black"); // Cambiar el color de vuelta a negro después del título
      } else if (line.trim() === "") {
        doc.moveDown();
      } else if (line.startsWith("#")) {
        // Manejar subtítulos basados en niveles de encabezado Markdown
        const level = (line.match(/#/g) || []).length;
        const fontSize = level === 1 ? 22 : level === 2 ? 18 : 16;
        const text = line.replace(/#/g, "").trim();
        doc
          .moveDown()
          .fontSize(fontSize)
          .font("Helvetica-Bold")
          .text(text)
          .moveDown(0.5);
      } else if (line.startsWith("-")) {
        // Manejar listas con viñetas
        const listItem = line.replace(/^- /, "").trim();
        doc
          .fontSize(12)
          .text(`• ${listItem}`, { indent: 20 })
          .moveDown(0.3); // Añadir un pequeño espacio entre elementos de lista
      } else if (line.includes("**")) {
        // Procesar texto con negritas delimitadas por ** con ajuste adicional
        const parts = line.split("**");
        parts.forEach((part, index) => {
          if (index % 2 === 1) {
            doc
              .font("Helvetica-Bold")
              .text(part.trim(), { continued: index < parts.length - 1 });
          } else {
            doc
              .font("Helvetica")
              .text(part.trim(), { continued: index < parts.length - 1 });
          }
        });
        doc.moveDown(0.5); // Asegurar un salto de línea después del texto en negrita
      } else {
        // Texto normal
        doc.fontSize(12).font("Helvetica").text(line.trim(), { align: "left" });
        doc.moveDown(0.5); // Asegurar un pequeño espacio después de cada línea
      }
    });

    doc.moveDown().lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.end();

    writeStream.on("finish", async () => {
      const fileUrl = `${req.protocol}://${req.get("host")}/pdfs/${filename}`;
      
      // Guardar o actualizar datos en PostgreSQL
      try {
        const { patientId, name } = data;
        const jsonData = JSON.stringify(data);

        console.log("Datos a insertar/actualizar en la base de datos:");
        console.log("patientId:", patientId);
        console.log("name:", name);
        console.log("data:", jsonData);

        const query = `
          INSERT INTO patient_data (patientId, name, data)
          VALUES ($1, $2, $3)
          ON CONFLICT (patientId)
          DO UPDATE SET
            name = EXCLUDED.name,
            data = EXCLUDED.data;
        `;

        await pool.query(query, [patientId, name, jsonData]);

        res.json({ fileUrl, message: "Datos insertados o actualizados correctamente" });
      } catch (dbError) {
        console.error("Error al insertar o actualizar datos en la base de datos:", dbError);
        res.status(500).json({ error: "Error al insertar o actualizar datos en la base de datos" });
      }
    });

    writeStream.on("error", (err) => {
      console.error("Error al escribir el archivo PDF:", err);
      res.status(500).json({ error: "Error al generar el PDF" });
    });
  } catch (error) {
    console.error("Error al consultar la API de ChatGPT:", error);
    res.status(500).json({ error: "Error al consultar la API de ChatGPT" });
  }
});

app.use("/pdfs", express.static(path.join(__dirname, "pdfs")));

const server = app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
  });
  server.setTimeout(30000); // Aumenta el tiempo de espera a 30 segundos
