var request = require('request');
var moment = require('moment');

// settings
var isTest = true,
    ENV = 'DEV',
    take = 10,
    interval = 15000;

// moyo auth
function getUserGuid () {
  switch (ENV) {
    case 'PROD':
      return '82db1ede-a617-2325-c9c4-1325d40e29ec';
    case 'STAGE':
      return '58062a37-37a1-457e-a8e8-eeb1a19a99f1';
    default:
      return '57a23807-ae1e-462c-a212-051272b6a0b1';
  }
}
var AUTH_NAME = process.env.MOYO_AUTH_NAME || 'dev',
    AUTH_PASSWORD = process.env.MOYO_AUTH_PASSWORD || '',
    auth = 'Basic ' + new Buffer(AUTH_NAME + ':' + AUTH_PASSWORD).toString('base64'),
    MOYO_URL = process.env.MOYO_API_ENDPOINT || 'http://moyo.quartethealth.local:3000',
    QUERY_URL = MOYO_URL + '/query/v1',
    WRITE_URL = MOYO_URL + '/write',
    headers = {
      'X-QH-USER-GUID': getUserGuid(),
      'Authorization':  auth,
      'Content-Type': 'application/json'
    };

// writes
treatmentPlanWrite = (patientId, treatmentPlan) => ([{
  "model": "patient",
  "op": "update",
  "quartetId": patientId,
  "attributes": {
    "treatmentPlan": {
      "model": "treatmentPlan",
      "op": "create",
      "attributes": treatmentPlan
    }
  }
}]);

function writeTreatmentPlan (patientId, treatmentPlan) {
  if (isTest) {
    console.log(patientId, treatmentPlan);
  } else {
    request({
      method: 'POST',
      url: WRITE_URL,
      headers,
      body: JSON.stringify(treatmentPlanWrite(patientId, treatmentPlan))
    }, function (err, data) {
      if (err) {
        console.error('Error writing treatmentPlan for patient ' + patientId + ' : ' + err);
      } else {
        console.log('.');
      }
    });
  }
};

// queries
var patientsWithoutTPQuery = (drop) => ({
  "model": "patient",
  "filters": [
      {
    	  "attribute":"quartetId",
        "constraint": {"type": "present"}
      },
      {
      	"attribute":"treatmentPlan",
        "constraint": {"type": "missing"}
      }
    ],
    "select": ["quartetId", "treatmentPlan", {
    	"serviceRequest/_patient": ["quartetId", "createdAt", "isRequestingPatientReferral"]
    }],
    "paginate": {
    	"attribute": "createdAt",
      "order": "descending",
      "take": take,
      "drop": drop
    }
});
var apptsWithConsultQuery = (serviceRequestId) => ({
  "model": "serviceRequest",
  "filters": [
    {
  	  "attribute":"quartetId",
      "constraint": {
        "type": "equals",
        "value": serviceRequestId
      }
    },
    {
    	"constraint": {
    		"type": "backref",
    		"model": "appointment",
    		"attribute": "serviceRequest",
    		"filters": [{
    			"attribute": "consultNote",
    			"constraint": { "type": "present"}
    		}]
    	}
    }
  ],
  "select": [ "quartetId", {
    "appointment/_serviceRequest": ["quartetId", "consultNote"]
  }],
  "paginate": {
  	"attribute": "createdAt",
    "order": "descending",
    "take": 10,
    "drop": 0
  }
});

// helpers
function sortReferralSRs (serviceRequests = []) {
  var srList = [], createdAt;
  serviceRequests.forEach(sr => {
    if (sr.isRequestingPatientReferral) {
      try {
        if (srList.length === 0) {
          srList.push(sr);
        } else {
          createdAt = moment(sr.createdAt);
          srList.forEach(sortedSr, index => {
            if (index === srList.length) {
              srList.push(sr);
            } else if (sortedSr.createdAt && createdAt.isBefore(moment(sortedSr.createdAt))) {
              srList = [sr].concat(srList);
            }
          });
        }
      } catch (err) {
        console.error('Error sorting SR', sr, err);
      }
    }
  });
  return srList;
}

function searchApptsForConsult (serviceRequestId, patientId) {
  request({
    method: 'POST',
    url: QUERY_URL,
    headers,
    body: JSON.stringify(apptsWithConsultQuery(serviceRequestId))
  }, function (err, data) {
    if (err) {
      console.error('Error fetching appointments for serviceRequest ' + serviceRequestId + '. ', err);
    }

    if (data && data.body) {
      try {
        var response = JSON.parse(data.body),
            appointmentList = response.entities.length ? response.entities[0].appointment : [],
            consultNoteList = appointmentList.map(appt => appt.consultNote);

        consultNoteList.forEach(noteJSON => {
          try {
            consultNote = JSON.parse(noteJSON) || {};
            if (consultNote.diagnosis && consultNote.plan) {
              writeTreatmentPlan(patientId, {
                diagnosis: consultNote.diagnosis,
                plan: consultNote.plan
              });
            }
          } catch (err) {
            console.error('ERROR parsing consult note for SR', serviceRequestId, err);
          }
        });

      } catch (error) {
        console.error('Error fetching appointments for serviceRequest ' + serviceRequestId + '. ', error);
      }
    }
  });
}

/*                                                      */
/*  Run this for every patient without a treatmentPlan  */
/*                                                      */
function getPatients (drop = 0) {
  console.log('Getting patients ' + drop + ' to ' + (drop + take) + '...');
  var patients, response;

  request({
    method: 'POST',
    url: QUERY_URL,
    headers,
    body: JSON.stringify(patientsWithoutTPQuery(drop))
  }, function (err, data) {
    if (data && data.body) {
      response = JSON.parse(data.body);
      patients = response.entities;
      patients.forEach(patient => {
        var srList = sortReferralSRs(patient.serviceRequest);
        if (srList && srList.length) {
          var mostRecentSr = srList[0];
          if (isTest) { console.log('|'); }
          // attempt to populate treatment plan from a consult note
          searchApptsForConsult(mostRecentSr.quartetId, patient.quartetId);
        } else {
          if (isTest) { console.log('x'); }
        }


      });

      //Keep running until all batches are complete
      drop += take;
      if (drop <= response['total-count']) {
        setTimeout(function () { getPatients(drop) }, interval);
      }
    } else {
      if (err) {
        console.error('Error fetching patients [' + drop + '] : ' + err);
      } else {
        console.error('Error fetching patients [' + drop + ']!');
      }
    }
  });
}

console.log('Backfill Patient Treatment Plan from Consult Notes:');
setTimeout(function () { getPatients() });
