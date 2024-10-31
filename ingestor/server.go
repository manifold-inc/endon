package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/aidarkhanov/nanoid"
	influxdb2 "github.com/influxdata/influxdb-client-go/v2"
	"github.com/influxdata/influxdb-client-go/v2/api/write"
	"github.com/labstack/echo/v4"
)

var Reset = "\033[0m"
var Red = "\033[31m"
var Green = "\033[32m"
var Yellow = "\033[33m"
var Blue = "\033[34m"
var Purple = "\033[35m"
var Cyan = "\033[36m"
var Gray = "\033[37m"
var White = "\033[97m"
var organizationID string

type Context struct {
	echo.Context
	Info  *log.Logger
	Warn  *log.Logger
	Err   *log.Logger
	reqid string
}

type ErrorReport struct {
	Service   string `json:"service"`
	Endpoint  string `json:"endpoint"`
	Error     string `json:"error"`
	Traceback string `json:"traceback,omitempty"`
}

func main() {
	TOKEN := safeEnv("DOCKER_INFLUXDB_TOKEN")
	HOST := safeEnv("DOCKER_INFLUXDB_HOST")
	ORG := safeEnv("DOCKER_INFLUXDB_ORGANIZATION")
	BUCKET := safeEnv("DOCKER_INFLUXDB_BUCKET")

	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			reqId, _ := nanoid.Generate("0123456789abcdefghijklmnopqrstuvwxyz", 12)
			InfoLog := log.New(os.Stdout, fmt.Sprintf("%sINFO [%s]: %s", Green, reqId, Reset), log.Ldate|log.Ltime|log.Lshortfile)
			WarnLog := log.New(os.Stdout, fmt.Sprintf("%sWARNING [%s]: %s", Yellow, reqId, Reset), log.Ldate|log.Ltime|log.Lshortfile)
			ErrLog := log.New(os.Stdout, fmt.Sprintf("%sERROR [%s]: %s", Red, reqId, Reset), log.Ldate|log.Ltime|log.Lshortfile)
			cc := &Context{c, InfoLog, WarnLog, ErrLog, reqId}
			return next(cc)
		}
	})

	client := influxdb2.NewClient(HOST, TOKEN)
	defer client.Close()

	org, err := client.OrganizationsAPI().FindOrganizationByName(context.Background(), ORG)
	if err != nil {
		log.Printf("%sERROR: Failed to lookup organization named %q: %v%s", Red, ORG, err, Reset)
		log.Fatal("Cannot start server without InfluxDB organization access")
	}
	log.Printf("Organization found: %+v\n", org)
	organizationID = *org.Id
	log.Printf("Organization ID: %s\n", organizationID)

	writeAPI := client.WriteAPIBlocking(ORG, BUCKET)

	e.POST("/", func(c echo.Context) error {
		cc := c.(*Context)

		// Add Content-Type validation
		if c.Request().Header.Get("Content-Type") != "application/json" {
			cc.Err.Printf("Invalid Content-Type. Expected application/json, got %s", c.Request().Header.Get("Content-Type"))
			return c.JSON(http.StatusUnsupportedMediaType, "Content-Type must be application/json")
		}

		cc.Info.Printf("Attempting ingestion to DB\n")

		// Read request body
		body, err := io.ReadAll(c.Request().Body)
		if err != nil {
			cc.Err.Printf("Error reading request body: %v", err)
			return c.JSON(http.StatusBadRequest, "Error reading request body")
		}

		var report ErrorReport
		if err := json.Unmarshal(body, &report); err != nil {
			cc.Err.Printf("Error unmarshalling JSON: %v", err)
			return c.JSON(http.StatusBadRequest, "Error unmarshalling JSON")
		}

		if report.Service == "" || report.Endpoint == "" || report.Error == "" {
			cc.Err.Printf("Missing required fields in the JSON payload")
			return c.JSON(http.StatusBadRequest, "Missing required fields in the JSON payload")
		}

		// Create fields map with required error field
		fields := map[string]interface{}{
			"error": report.Error,
		}

		// Only add traceback if it's not empty
		if report.Traceback != "" {
			fields["traceback"] = report.Traceback
		}

		// Create the Influx DB point
		point := write.NewPoint(
			"error_logs",
			map[string]string{
				"service":  report.Service,
				"endpoint": report.Endpoint,
			},
			fields,
			time.Now(),
		)

		// Write point asynchronously
		if err := writeAPI.WritePoint(context.Background(), point); err != nil {
			cc.Err.Printf("Error writing point to InfluxDB: %v", err)
			return c.JSON(http.StatusInternalServerError, "Error writing point to InfluxDB")
		}

		return cc.JSON(http.StatusOK, "Error logged")
	})
	e.Logger.Fatal(e.Start(":80"))
}
