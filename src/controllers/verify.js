// Load environment variables from .env file
require('dotenv').config();

// Import required modules
const express = require("express");
const app = express(); // Create an instance of the Express application
const path = require("path");
const fs = require("fs");
const axios = require('axios');
const moment = require('moment');
const { ethers } = require("ethers"); // Ethereum JavaScript library
const { validationResult } = require("express-validator");
// Import custom cryptoFunction module for encryption and decryption
const { decryptData, generateEncryptedUrl } = require("../common/cryptoFunction");

const pdf = require("pdf-lib"); // Library for creating and modifying PDF documents
const { PDFDocument } = pdf;

// Import MongoDB models
const { Issues, BatchIssues, ShortUrl, User } = require("../config/schema");

// Import ABI (Application Binary Interface) from the JSON file located at "../config/abi.json"
const abi = require("../config/abi.json");

// Importing functions from a custom module
const {
  extractQRCodeDataFromPDF, // Function to extract QR code data from a PDF file
  cleanUploadFolder, // Function to clean up the upload folder
  isDBConnected, // Function to check if the database connection is established
  extractCertificateInfo,
  verificationLogEntry,
  isCertificationIdExisted
} = require('../model/tasks'); // Importing functions from the '../model/tasks' module

// Retrieve contract address from environment variable
const contractAddress = process.env.CONTRACT_ADDRESS;

// Define an array of providers to use as fallbacks
const providers = [
  new ethers.AlchemyProvider(process.env.RPC_NETWORK, process.env.ALCHEMY_API_KEY),
  new ethers.InfuraProvider(process.env.RPC_NETWORK, process.env.INFURA_API_KEY)
  // Add more providers as needed
];

// Create a new FallbackProvider instance
const fallbackProvider = new ethers.FallbackProvider(providers);

// Create a new ethers signer instance using the private key from environment variable and the provider(Fallback)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, fallbackProvider);

// Create a new ethers contract instance with a signing capability (using the contract Address, ABI and signer)
const newContract = new ethers.Contract(contractAddress, abi, signer);

var messageCode = require("../common/codes");
const e = require('express');

const urlLimit = process.env.MAX_URL_SIZE || 50;

/**
 * Verify Certification page with PDF QR - Blockchain URL.
 *
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
const verify = async (req, res) => {
  // Extracting file path from the request
  file = req.file.path;

  var fileBuffer = fs.readFileSync(file);
  var pdfDoc = await PDFDocument.load(fileBuffer);
  var certificateS3Url;
  // Get today's date
  const getTodayDate = async () => {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0'); // Add leading zero if month is less than 10
    const day = String(today.getDate()).padStart(2, '0'); // Add leading zero if day is less than 10
    const year = today.getFullYear();
    return `${month}/${day}/${year}`;
  };
  const todayDate = await getTodayDate();

  if (pdfDoc.getPageCount() > 1) {
    // Respond with success status and certificate details
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    // Clean up the upload folder
    await cleanUploadFolder();
    return res.status(400).json({ status: "FAILED", message: messageCode.msgMultiPagePdf });
  }

  try {
    // Extract QR code data from the PDF file
    const [certificateData, originalUrl] = await extractQRCodeDataFromPDF(file);

    if (certificateData === false) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
      // Clean up the upload folder
      await cleanUploadFolder();
      return res.status(400).json({ status: "FAILED", message: messageCode.msgCertNotValid });
    }

    var verifyLog = {
      issuerId: "default",
      course: certificateData["Course Name"]
    };

    const certificationNumber = certificateData['Certificate Number'];
    const singleIssueExist = await Issues.findOne({ certificateNumber: certificationNumber });
    const batchIssueExist = await BatchIssues.findOne({ certificateNumber: certificationNumber });

    // Validation checks for request data
    if (singleIssueExist) {

      if (singleIssueExist.certificateStatus == 3) {
        res.status(400).json({ status: "FAILED", message: messageCode.msgCertRevoked });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }

      if (singleIssueExist.certificateStatus == 6) {

        var dbStatus = await isDBConnected();
        // certificateS3Url = singleIssueExist.url != null ? singleIssueExist.url : null;
        certificateData.url = originalUrl;
        // certificateData.certificateUrl = certificateS3Url;

        res.status(200).json({
          status: "SUCCESS",
          message: "Certification is valid",
          Details: certificateData
        });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }

      if (certificateData['Expiration Date'] == '1') {

        verifyLog.issuerId = singleIssueExist.issuerId;
        var dbStatus = await isDBConnected();
        if (dbStatus) {
          await verificationLogEntry(verifyLog);
        }

        certificateS3Url = singleIssueExist.url != null ? singleIssueExist.url : null;
        certificateData.url = originalUrl;
        certificateData.certificateUrl = certificateS3Url;

        res.status(200).json({
          status: "SUCCESS",
          message: "Certification is valid",
          Details: certificateData
        });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }
      try {
        // Blockchain processing.
        var verifyCert = await newContract.verifyCertificateById(certificationNumber);
        var _certStatus = await newContract.getCertificateStatus(certificationNumber);

        var verifyCertStatus = parseInt(verifyCert[3]);
        var certStatus = parseInt(_certStatus);
        if (certStatus == 3) {
          res.status(400).json({ status: "FAILED", message: messageCode.msgCertRevoked });
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
          // Clean up the upload folder
          await cleanUploadFolder();
          return;
        }

        if (verifyCert[0] == false && verifyCertStatus == 5) {
          res.status(400).json({ status: "FAILED", message: messageCode.msgCertExpired });
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
          // Clean up the upload folder
          await cleanUploadFolder();
          return;
        }
      } catch (error) {
        res.status(400).json({ status: "FAILED", message: messageCode.msgFailedAtBlockchain, details: error });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }

      if (verifyCert[0] === true) {

        const foundCertification = certificateData;

        verifyLog.issuerId = singleIssueExist.issuerId;

        var dbStatus = await isDBConnected();
        if (dbStatus != false) {
          await verificationLogEntry(verifyLog);
        }

        certificateS3Url = singleIssueExist.url != null ? singleIssueExist.url : null;
        foundCertification['Expiration Date'] = singleIssueExist.expirationDate;
        foundCertification.url = originalUrl;
        foundCertification.certificateUrl = certificateS3Url;

        const verificationResponse = {
          status: "SUCCESS",
          message: "Certification is valid",
          Details: foundCertification
        };
        res.status(200).json(verificationResponse);
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      } else if (verifyCert[0] === false) {
        res.status(400).json({ status: "FAILED", message: messageCode.msgInvalidCert });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }


    } else if (batchIssueExist) {

      if (batchIssueExist.certificateStatus == 3) {
        res.status(400).json({ status: "FAILED", message: messageCode.msgCertRevoked });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }

      if (certificateData['Expiration Date'] == '1') {

        // Add the issuerId parameter
        verifyLog.issuerId = batchIssueExist.issuerId;

        var dbStatus = await isDBConnected();
        if (dbStatus != false) {
          await verificationLogEntry(verifyLog);
        }

        certificateS3Url = batchIssueExist.url != null ? batchIssueExist.url : null;
        certificateData.url = originalUrl;
        certificateData.certificateUrl = certificateS3Url;

        res.status(200).json({
          status: "SUCCESS",
          message: "Certification is valid",
          Details: certificateData
        });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }
      if (certificateData['Expiration Date'].length == 10) {
        // Convert data string to a Date object
        const dataDate = new Date(certificateData['Expiration Date']);
        if (dataDate < todayDate) {
          res.status(400).json({ status: "FAILED", message: messageCode.msgCertExpired });
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
          // Clean up the upload folder
          await cleanUploadFolder();
          return;
        }
      }
      const batchNumber = (batchIssueExist.batchId) - 1;
      const dataHash = batchIssueExist.certificateHash;
      const proof = batchIssueExist.proofHash;
      const hashProof = batchIssueExist.encodedProof;
      try {
        // Blockchain processing.
        var batchVerifyResponse = await newContract.verifyBatchCertification(batchNumber, dataHash, proof);
        var _responseStatus = await newContract.verifyCertificateInBatch(hashProof);
        var responseStatus = parseInt(_responseStatus);
        if (responseStatus == 3) {
          res.status(400).json({ status: "FAILED", message: messageCode.msgCertRevoked });
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
          // Clean up the upload folder
          await cleanUploadFolder();
          return;
        }

        if (responseStatus == 5) {
          res.status(400).json({ status: "FAILED", message: messageCode.msgCertExpired });
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
          // Clean up the upload folder
          await cleanUploadFolder();
          return;
        }
      } catch (error) {
        res.status(400).json({ status: "FAILED", message: messageCode.msgFailedAtBlockchain, details: error });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }

      if (batchVerifyResponse === true) {

        try {

          var completeResponse = certificateData;

          // Add the issuerId parameter
          verifyLog.issuerId = batchIssueExist.issuerId;

          var dbStatus = await isDBConnected();
          if (dbStatus != false) {
            await verificationLogEntry(verifyLog);
          }

          certificateS3Url = batchIssueExist.url != null ? batchIssueExist.url : null;
          completeResponse['Expiration Date'] = batchIssueExist.expirationDate;
          completeResponse.url = originalUrl;
          completeResponse.certificateUrl = certificateS3Url;

          const _verificationResponse = {
            status: "SUCCESS",
            message: "Certification is valid",
            Details: completeResponse
          };

          res.status(200).json(_verificationResponse);
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
          // Clean up the upload folder
          await cleanUploadFolder();
          return;

        } catch (error) {
          res.status(500).json({ status: "FAILED", message: messageCode.msgInternalError, details: error });
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
          // Clean up the upload folder
          await cleanUploadFolder();
          return;
        }
      } else {
        res.status(400).json({ status: "FAILED", message: messageCode.msgCertNotExist });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }


    } else if (!batchIssueExist && !singleIssueExist) {
      if (certificateData['Expiration Date'] == '1') {
        var dbStatus = await isDBConnected();
        if (dbStatus != false) {
          await verificationLogEntry(verifyLog);
        }
        certificateData.url = originalUrl;
        certificateData.certificateUrl = "";

        res.status(200).json({
          status: "SUCCESS",
          message: "Certification is valid",
          Details: certificateData
        });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }
      // Extract blockchain URL from the certificate data
      const blockchainUrl = certificateData["Polygon URL"];

      var fomatedDate = await detectDateFormat(certificateData['Expiration Date']);

      if (fomatedDate != null) {
        var compareDate = await compareDates(fomatedDate, todayDate);
        if (!compareDate) {
          res.status(400).json({ status: "FAILED", message: messageCode.msgCertExpired });
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
          // Clean up the upload folder
          await cleanUploadFolder();
          return;
        }
      }

      // Check if a blockchain URL exists and is valid
      if (blockchainUrl && blockchainUrl.length > 0) {
        var dbStatus = await isDBConnected();
        if (dbStatus != false) {
          await verificationLogEntry(verifyLog);
        }
        certificateData.url = originalUrl;
        certificateData.certificateUrl = "";
        // Respond with success status and certificate details
        res.status(200).json({ status: "SUCCESS", message: messageCode.msgCertValid, Details: certificateData });
        // await cleanUploadFolder();
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      } else {
        // Respond with failure status if no valid blockchain URL is found
        res.status(400).json({ status: "FAILED", message: messageCode.msgCertNotValid });
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }

    } else {
      // Respond with failure status if no valid blockchain URL is found
      res.status(400).json({ status: "FAILED", message: messageCode.msgCertNotValid });
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
      // Clean up the upload folder
      await cleanUploadFolder();
      return;
    }

  } catch (error) {
    // If an error occurs during verification, respond with failure status
    const verificationResponse = {
      status: "FAILED",
      message: messageCode.msgCertNotValid
    };

    res.status(400).json(verificationResponse);
    // Clean up the upload folder
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    // Clean up the upload folder
    await cleanUploadFolder();
    return;
  }

  // Delete the uploaded file after verification
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }

  // Clean up the upload folder
  await cleanUploadFolder();
};

/**
 * Handles the decoding of a certificate from an encrypted link Fetched after Mobile/Webcam Scan.
 *
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */

const decodeQRScan = async (req, res) => {
  const receivedCode = req.body.receivedCode;
  if (!receivedCode) {
    // Respond with error message
    return res.status(400).json({ status: "FAILED", message: messageCode.msgInvalidInput });
  }
  // console.log("Input QR data", receivedCode);

  var responseUrl = null;
  var decodeResponse = false;
  var certificateS3Url;
  try {

    if (receivedCode.startsWith(process.env.START_URL) || receivedCode.startsWith(process.env.START_VERIFY_URL)) {
      var urlSize = receivedCode.length;
      if (urlSize < urlLimit) {
        // Parse the URL
        const parsedUrl = new URL(receivedCode);
        // Extract the query parameter
        const certificationNumber = parsedUrl.searchParams.get('');
        try {
          var dbStatus = await isDBConnected();

          var isUrlExist = await ShortUrl.findOne({ certificateNumber: certificationNumber });


          if (isUrlExist) {
            // console.log("The original url", isUrlExist.url);
            responseUrl = isUrlExist.url;
            if (responseUrl && (responseUrl.startsWith(process.env.START_VERIFY_URL) || responseUrl.startsWith(process.env.START_URL))) {
              var [decodeResponse, originalUrl] = await extractCertificateInfo(responseUrl);
            } else {
              return res.status(400).json({ status: "FAILED", message: messageCode.msgInvalidUrl });
            }
          }

          if (decodeResponse) {
            let isCertExist = await isCertificationIdExisted(decodeResponse['Certificate Number']);
            certificateS3Url = isCertExist.url != null ? isCertExist.url : null;
            if (isCertExist && (isCertExist.certificateStatus == 3)) {
              return res.status(400).json({ status: "FAILED", message: messageCode.msgCertRevoked });
            }
          }

          var isUserExist = await User.findOne({ email: isUrlExist.email });
          var getIssuerId = isUserExist != null ? isUserExist.issuerId : 'default';

          var verificationResponse = decodeResponse != false ? decodeResponse : "";

        } catch (error) {
          return res.status(500).json({ status: "FAILED", message: messageCode.msgInternalError, error: error });
        }
        verificationResponse.url = originalUrl;
        verificationResponse.certificateUrl = certificateS3Url;
        var verifyLog = {
          issuerId: getIssuerId,
          course: verificationResponse["Course Name"],
        };
        await verificationLogEntry(verifyLog);
        return res.status(200).json({ status: "SUCCESS", message: messageCode.msgCertValid, Details: verificationResponse });
      }

      responseUrl = receivedCode;
      var [extractQRData, encodedUrl] = await extractCertificateInfo(responseUrl);
      if (extractQRData) {
        try {
          var dbStatus = await isDBConnected();
          if (dbStatus) {
            var getCertificationInfo = await isCertificationIdExisted(extractQRData['Certificate Number']);
            if (getCertificationInfo) {
              certificateS3Url = getCertificationInfo.url != null ? getCertificationInfo.url : null;
              var formatCertificationStatus = parseInt(getCertificationInfo.certificateStatus);
              if (formatCertificationStatus && formatCertificationStatus == 3) {
                return res.status(400).json({ status: "FAILED", message: messageCode.msgCertRevoked });
              }
            }
          }
        } catch (error) {
          return res.status(500).json({ status: "FAILED", message: messageCode.msgInternalError, details: error });
        }
        extractQRData.url = encodedUrl;
        res.status(200).json({ status: "PASSED", message: messageCode.msgCertValid, Details: extractQRData });
        return;
      }
      return res.status(400).json({ status: "FAILED", message: messageCode.msgInvalidCert });

    } else if (receivedCode.startsWith(process.env.START_LMS)) {

      var [extractQRData, decodedUrl] = await extractCertificateInfo(receivedCode);
      if (extractQRData) {
        var verifyLog = {
          issuerId: 'default',
          course: extractQRData["Course Name"],
        };
        await verificationLogEntry(verifyLog);

        extractQRData.url = decodedUrl;
        extractQRData.certificateUrl = certificateS3Url;
        res.status(200).json({ status: "PASSED", message: messageCode.msgCertValid, Details: extractQRData });
        return;
      }
      return res.status(400).json({ status: "FAILED", message: messageCode.msgInvalidCert });

    } else {
      return res.status(400).json({ status: "FAILED", message: messageCode.msgInvalidCert });
    }
  } catch (error) {
    // Handle errors and send an appropriate response
    console.error(error);
    return res.status(500).json({ status: "FAILED", message: messageCode.msgInternalError });
  }
};

/**
 * Handles the decoding of a certificate from an encrypted link.
 *
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
const decodeCertificate = async (req, res) => {
  try {
    // Extract encrypted link from the request body
    const encryptedData = req.body.encryptedData;
    const iv = req.body.iv;

    // Decrypt the link
    const decryptedData = decryptData(encryptedData, iv);

    const originalData = JSON.parse(decryptedData);

    var originalUrl = generateEncryptedUrl(originalData);

    let isValid = false;
    let messageContent = "Not Verified"
    let parsedData;
    var certificateS3Url;
    if (originalData !== null) {
      parsedData = {
        "Certificate Number": originalData.Certificate_Number || "",
        "Course Name": originalData.courseName || "",
        "Expiration Date": originalData.Expiration_Date || "",
        "Grant Date": originalData.Grant_Date || "",
        "Name": originalData.name || "",
        "Polygon URL": originalData.polygonLink || ""
      };

      var getCertificationInfo = await isCertificationIdExisted(parsedData['Certificate Number']);

      var verifyLog = {
        issuerId: "default",
        course: parsedData["Course Name"]
      };
      isValid = true
      var dbStatus = await isDBConnected();
      if (dbStatus != false) {
        var getValidCertificatioInfo = await isCertificationIdExisted(originalData.Certificate_Number);
        if (getValidCertificatioInfo) {
          certificateS3Url = getValidCertificatioInfo.url != null ? getValidCertificatioInfo.url : null;
          verifyLog.issuerId = getValidCertificatioInfo.issuerId;
          parsedData['Expiration Date'] = getValidCertificatioInfo.expirationDate;
          parsedData.certificateUrl = certificateS3Url;
          var formatCertificationStatus = parseInt(getCertificationInfo.certificateStatus);
          var certificationStatus = formatCertificationStatus || 0;
          if ((certificationStatus != 0) && (certificationStatus == 3)) {
            isValid = false;
            messageContent = "Certification has Revoked";
          }
        }
      }
    }

    // Respond with the verification status and decrypted data if valid
    if (isValid) {
      if (dbStatus) {
        await verificationLogEntry(verifyLog);
      }
      parsedData.url = originalUrl || null;
      res.status(200).json({ status: "PASSED", message: "Verified", data: parsedData });
    } else {
      res.status(200).json({ status: "FAILED", message: messageContent });
    }
  } catch (error) {
    // Handle errors and send an appropriate response
    console.error(error);
    res.status(500).json({ message: messageCode.msgInternalError });
  }
};

/**
 * API call for Single / Batch Certificates verify with Certification ID.
 *
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
const verifyCertificationId = async (req, res) => {
  var validResult = validationResult(req);
  if (!validResult.isEmpty()) {
    return res.status(422).json({ status: "FAILED", message: messageCode.msgEnterInvalid, details: validResult.array() });
  }
  const inputId = req.body.id;
  var certificateS3Url;
  // Get today's date
  const getTodayDate = async () => {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0'); // Add leading zero if month is less than 10
    const day = String(today.getDate()).padStart(2, '0'); // Add leading zero if day is less than 10
    const year = today.getFullYear();
    return `${month}/${day}/${year}`;
  };
  try {
    let dbStatus = await isDBConnected();
    const dbStatusMessage = (dbStatus == true) ? messageCode.msgDbReady : messageCode.msgDbNotReady;
    console.log(dbStatusMessage);

    const singleIssueExist = await Issues.findOne({ certificateNumber: inputId });
    const batchIssueExist = await BatchIssues.findOne({ certificateNumber: inputId });
    const urlIssueExist = await ShortUrl.findOne({ certificateNumber: inputId });
    // Blockchain processing.
    const verifyCertification = await newContract.verifyCertificateById(inputId);

    // Validation checks for request data
    if (!batchIssueExist && !singleIssueExist) {
      if (verifyCertification && verifyCertification[0] === true) {
        res.status(200).json({
          status: "SUCCESS",
          message: `${inputId} : ${messageCode.msgVlidCertNoDb}`
        });
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }
      // Respond with error message
      return res.status(400).json({ status: "FAILED", message: messageCode.msgCertNotValid });
    }

    if (singleIssueExist) {

      var verifyLog = {
        issuerId: singleIssueExist.issuerId,
        course: singleIssueExist.course
      };
      if (singleIssueExist.certificateStatus == 3) {
        return res.status(400).json({ status: "FAILED", message: messageCode.msgCertRevoked });
      }

      if (singleIssueExist.certificateStatus == 6) {
        var _polygonLink = `https://${process.env.NETWORK}/tx/${singleIssueExist.transactionHash}`;

        var completeResponse = {
          'Certificate Number': singleIssueExist.certificateNumber,
          'Name': singleIssueExist.name,
          'Course Name': singleIssueExist.course,
          'Grant Date': singleIssueExist.grantDate,
          'Expiration Date': singleIssueExist.expirationDate,
          'Polygon URL': _polygonLink
        };

        if (urlIssueExist) {
          completeResponse.url = urlIssueExist.url;
        } else {
          completeResponse.url = null;
        }

        certificateS3Url = singleIssueExist.url != null ? singleIssueExist.url : null;
        completeResponse.certificateUrl = certificateS3Url;

        res.status(200).json({
          status: "SUCCESS",
          message: "Certification is valid",
          details: completeResponse
        });
        return;
      }
      try {

        if (singleIssueExist.expirationDate == '1') {
          var _polygonLink = `https://${process.env.NETWORK}/tx/${singleIssueExist.transactionHash}`;

          var completeResponse = {
            'Certificate Number': singleIssueExist.certificateNumber,
            'Name': singleIssueExist.name,
            'Course Name': singleIssueExist.course,
            'Grant Date': singleIssueExist.grantDate,
            'Expiration Date': singleIssueExist.expirationDate,
            'Polygon URL': _polygonLink
          };

          if (dbStatus) {
            await verificationLogEntry(verifyLog);
          }

          if (urlIssueExist) {
            completeResponse.url = urlIssueExist.url;
          } else {
            completeResponse.url = null;
          }

          certificateS3Url = singleIssueExist.url != null ? singleIssueExist.url : null;
          completeResponse.certificateUrl = certificateS3Url;

          res.status(200).json({
            status: "SUCCESS",
            message: "Certification is valid",
            details: completeResponse
          });
          return;
        }
        try {
          // Blockchain processing.
          const verifyCert = await newContract.verifyCertificateById(inputId);
          const _certStatus = await newContract.getCertificateStatus(inputId);

          var verifyCertStatus = parseInt(verifyCert[3]);
          var certStatus = parseInt(_certStatus);
          if (certStatus == 3) {
            return res.status(400).json({ status: "FAILED", message: messageCode.msgCertRevoked });
          }

          if (verifyCert[0] == false && verifyCertStatus == 5) {
            return res.status(400).json({ status: "FAILED", message: messageCode.msgCertExpired });
          }

          if (verifyCert[0] == true) {

            var _polygonLink = `https://${process.env.NETWORK}/tx/${singleIssueExist.transactionHash}`;

            var completeResponse = {
              'Certificate Number': singleIssueExist.certificateNumber,
              'Name': singleIssueExist.name,
              'Course Name': singleIssueExist.course,
              'Grant Date': singleIssueExist.grantDate,
              'Expiration Date': singleIssueExist.expirationDate,
              'Polygon URL': _polygonLink
            };

            const foundCertification = (singleIssueExist != null) ? completeResponse : inputId;

            if (dbStatus) {
              await verificationLogEntry(verifyLog);
            }

            if (urlIssueExist) {
              foundCertification.url = urlIssueExist.url;
            } else {
              foundCertification.url = null;
            }

            certificateS3Url = singleIssueExist.url != null ? singleIssueExist.url : null;
            foundCertification.certificateUrl = certificateS3Url;
            const verificationResponse = {
              status: "SUCCESS",
              message: "Certification is valid",
              details: foundCertification
            };
            res.status(200).json(verificationResponse);
            // Clean up the upload folder
            await cleanUploadFolder();
            return;
          } else if (verifyCert[0] == false) {
            return res.status(400).json({ status: "FAILED", message: messageCode.msgInvalidCert });
          }

        } catch (error) {
          return res.status(400).json({ status: "FAILED", message: messageCode.msgFailedAtBlockchain, details: error });
        }
      } catch (error) {
        return res.status(400).json({ status: "FAILED", message: messageCode.msgFailedAtBlockchain, details: error });
      }

    } else if (batchIssueExist) {

      var verifyLog = {
        issuerId: batchIssueExist.issuerId,
        course: batchIssueExist.course
      };
      if (batchIssueExist.certificateStatus == 3) {
        return res.status(400).json({ status: "FAILED", message: messageCode.msgCertRevoked });
      }

      if (batchIssueExist.expirationDate == '1') {
        var _polygonLink = `https://${process.env.NETWORK}/tx/${batchIssueExist.transactionHash}`;

        var completeResponse = {
          'Certificate Number': batchIssueExist.certificateNumber,
          'Name': batchIssueExist.name,
          'Course Name': batchIssueExist.course,
          'Grant Date': batchIssueExist.grantDate,
          'Expiration Date': batchIssueExist.expirationDate,
          'Polygon URL': _polygonLink
        };

        if (dbStatus) {
          await verificationLogEntry(verifyLog);
        }

        if (urlIssueExist) {
          completeResponse.url = urlIssueExist.url;
        } else {
          completeResponse.url = null;
        }

        certificateS3Url = batchIssueExist.url != null ? batchIssueExist.url : null;
        completeResponse.certificateUrl = certificateS3Url;
        res.status(200).json({
          status: "SUCCESS",
          message: "Certification is valid",
          details: completeResponse
        });
        // Clean up the upload folder
        await cleanUploadFolder();
        return;
      }
      if ((batchIssueExist.expirationDate).length == 10) {
        var dateToday = await getTodayDate();
        var expirationDate = batchIssueExist.expirationDate;
        var compareResult = await compareDates(expirationDate, dateToday);
        if (!compareResult) {
          res.status(400).json({ status: "FAILED", message: messageCode.msgCertExpired });
          return;
        }
      }
      const batchNumber = (batchIssueExist.batchId) - 1;
      const dataHash = batchIssueExist.certificateHash;
      const proof = batchIssueExist.proofHash;
      const hashProof = batchIssueExist.encodedProof;
      try {
        // Blockchain processing.
        const batchVerifyResponse = await newContract.verifyBatchCertification(batchNumber, dataHash, proof);
        const _responseStatus = await newContract.verifyCertificateInBatch(hashProof);
        var responseStatus = parseInt(_responseStatus);
        if (responseStatus == 3) {
          return res.status(400).json({ status: "FAILED", message: messageCode.msgCertRevoked });
        }

        if (responseStatus == 5) {
          return res.status(400).json({ status: "FAILED", message: messageCode.msgCertExpired });
        }

        if (batchVerifyResponse === true) {

          try {

            var _polygonLink = `https://${process.env.NETWORK}/tx/${batchIssueExist.transactionHash}`;

            var completeResponse = {
              'Certificate Number': batchIssueExist.certificateNumber,
              'Name': batchIssueExist.name,
              'Course Name': batchIssueExist.course,
              'Grant Date': batchIssueExist.grantDate,
              'Expiration Date': batchIssueExist.expirationDate,
              'Polygon URL': _polygonLink
            };

            if (dbStatus) {
              await verificationLogEntry(verifyLog);
            }

            if (urlIssueExist) {
              completeResponse.url = urlIssueExist.url;
            } else {
              completeResponse.url = null;
            }

            certificateS3Url = batchIssueExist.url != null ? batchIssueExist.url : null;
            completeResponse.certificateUrl = certificateS3Url;
            const _verificationResponse = {
              status: "SUCCESS",
              message: "Certification is valid",
              details: completeResponse
            };
            res.status(200).json(_verificationResponse);
            // Clean up the upload folder
            await cleanUploadFolder();
            return;

          } catch (error) {
            return res.status(500).json({ status: "FAILED", message: messageCode.msgInternalError, details: error });
          }
        } else {
          return res.status(400).json({ status: "FAILED", message: messageCode.msgCertNotExist });
        }
      } catch (error) {
        return res.status(400).json({ status: "FAILED", message: messageCode.msgFailedAtBlockchain, details: error });
      }
    }
  } catch (error) {
    return res.status(500).json({ status: "FAILED", message: messageCode.msgInternalError, details: error });
  }

};

const detectDateFormat = async (dateString) => {
  const formats = ['DD MMMM YYYY', 'MMMM DD YYYY', 'MM/DD/YY', 'MM/DD/YYYY'];

  for (let format of formats) {
    const parsedDate = moment(dateString, format, true);
    if (parsedDate.isValid()) {
      // Convert to MM/DD/YYYY format
      const convertedDate = parsedDate.format('MM/DD/YYYY');
      return convertedDate;
    }
  }
  return null;
};

const compareDates = async (dateString1, dateString2) => {
  // Split the date strings into components
  const [month1, day1, year1] = dateString1.split('/');
  const [month2, day2, year2] = dateString2.split('/');

  // Create date objects for comparison
  const date1 = new Date(year1, month1 - 1, day1);
  const date2 = new Date(year2, month2 - 1, day2);

  if (date1 > date2) {
    return true;
  } else if (date1 == date2) {
    return true;
  } else {
    return false;
  }
};

module.exports = {
  // Function to verify a certificate with a PDF QR code
  verify,

  // Function to verify a Single/Batch certification with an ID
  verifyCertificationId,

  // Function to decode a certificate
  decodeCertificate,

  // Function to verify a certificate with a Scanned Short url/Original url based QR code
  decodeQRScan
};
