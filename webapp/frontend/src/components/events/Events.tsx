import Box from "@mui/material/Box";
import CssBaseline from "@mui/material/CssBaseline";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";

import Toolbar from "@mui/material/Toolbar";
import { API } from "aws-amplify";
import React from "react";
import { useEffect, useRef, useState } from "react";
import { getEventDetailsByUser, getEventDetailsByUserAndCreateTime } from "../../common/graphql/queries";
import { onCreateEventDetail } from "../../common/graphql/subscriptions";
import { EventDetail, PatientsDetail, UsersDetail } from "../../common/types/API";
import { getAbsoluteTimeFromRelativeTime, subtractHours } from "../../utils/time";

import "./events.css";
import { Sidebar } from "./Sidebar";

function createData(
    name: string,
    start: number,
    finish: number,
    mood: string,
    medication: string
) {
    return { name, start, finish, mood, medication };
}

const rows = [
    createData("Episode 1", 159, 6.0, "Happy", "None"),
    createData("Episode 2", 237, 9.0, "Happy", "None"),
    createData("Episode 3", 262, 16.0, "Happy", "None"),
];

const DEFAULT_HOURS_AGO = 3;

export const Events = (props: {
    userName: any,
    userId: any,
    userDetail: UsersDetail,
    patients: PatientsDetail[],
}) => {
    const [searchProperties, setSearchProperties] = React.useState<any>({
        start: subtractHours(new Date(), DEFAULT_HOURS_AGO),
        end: new Date(),
        startRelative: `${DEFAULT_HOURS_AGO}h`,
        endRelative: "0h",
        type: "relative",
        period: "5m",
        statistic: "avg",
        patient: "all"
    });
    const [isLoading, setIsLoading] = useState<any>(false);

    const [items, updateItems] = useState<Array<EventDetail>>(new Array<EventDetail>());
    const stateRef = useRef<Array<EventDetail>>();
    stateRef.current = items;


    async function callListAllEvents() {

        // Update the time (in case we are using relative times) before handling the update
        //
        let start = searchProperties.start;
        let end = searchProperties.end;
        setIsLoading(true);
        if (searchProperties.type === "relative") {
            start = getAbsoluteTimeFromRelativeTime(searchProperties.startRelative);
            end = getAbsoluteTimeFromRelativeTime(searchProperties.endRelative);
            setSearchProperties({
                ...searchProperties,
                start: start,
                end: end,
            });
        }

        const patientIds = searchProperties.patient === "all" ? props.userDetail.patient_ids : [searchProperties.patient];
        console.log("patientIds: ")
        console.log(patientIds)
        const items = [];
        if (patientIds) {
            for (const patientId of patientIds) {
                console.log("looking for patient ", patientId, searchProperties.start.toISOString(), searchProperties.end.toISOString())
                const events: any = await API.graphql({
                    query: getEventDetailsByUserAndCreateTime,
                    variables: {
                        userId: patientId,
                        startTime: searchProperties.start.toISOString(),
                        endTime: searchProperties.end.toISOString(),
                        limit: 100,
                    }
                });

                const itemsReturned: Array<EventDetail> = events['data']['getEventDetailsByUserAndCreateTime']['items'];
                for (var event of itemsReturned) {
                    items.push(event);
                }
            }
        }
        console.log("found items: ", items.length)
        updateItems(items);
        setIsLoading(false);
    }

    async function subscribeCreateEvents() {
        const subscription: any = API.graphql({
            query: onCreateEventDetail
        });

        subscription.subscribe({
            next: (data: any) => {
                console.log("data received from create subscription:", data);
                const newItems = [];
                let found = false;
                if (data.value.data) {
                    for (let item of stateRef.current!) {
                        if (data.value.data.onCreateEventDetail.userId === item.user_id) {
                            // Found existing item so we will update this item
                            newItems.push(data.value.data.onCreateEventDetail);
                            found = true;
                        } else {
                            // Keep existing item
                            newItems.push(item);
                        }
                    }
                    if (!found) {
                        newItems.push(data.value.data.onCreateEventDetail);
                    }
                    updateItems(newItems);
                }
            },
            error: (error: any) => console.warn(error)
        });
    };


    // async function subscribeUpdateMeetings() {
    //     const subscription:any = API.graphql({
    //         query: onUpdateMeetingDetail
    //     });

    //     subscription.subscribe({
    //         next: (data:any) => {
    //             const newItems = [];
    //             if (data.value.data.onUpdateMeetingDetail) {
    //                 for (let item of stateRef.current!) {
    //                     if (data.value.data.onUpdateMeetingDetail.meeting_id === item.meeting_id) {
    //                         // Found existing item so we will update this item
    //                         newItems.push(data.value.data.onUpdateMeetingDetail);
    //                     } else {
    //                         // Keep existing item
    //                         newItems.push(item);
    //                     }
    //                 }
    //                 updateItems(newItems);
    //             }
    //         },
    //         error: (error:any) => console.warn(error)
    //     });
    // };

    useEffect(() => {
        callListAllEvents()
        // subscribeCreateEvents()
        // subscribeUpdateMeetings()

    }, []);

    async function update() {
        callListAllEvents()
    }

    function getPatientName(patientId: string) {
        let patientName = "";
        for (const p of props.patients) {
            if (p.patient_id === patientId) {
                patientName = p.name!;
            }
        }
        return patientName;
    }

    return (
        <Box sx={{ display: "flex" }}>
            <CssBaseline />

            <Sidebar
                searchProperties={searchProperties}
                setSearchProperties={setSearchProperties}
                isLoading={isLoading}
                update={update}
                patients={props.patients}
                userName={props.userName}
            />

            <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
                <Toolbar />
                <TableContainer component={Paper}>
                    <Table sx={{ minWidth: 650 }} aria-label="caption table">
                        {
                            items.length == 0 && <caption>No events found</caption>
                        }
                        <TableHead>
                            <TableRow>
                                <TableCell>Start</TableCell>
                                <TableCell>Finish</TableCell>
                                <TableCell align="right">Name</TableCell>
                                <TableCell align="right">Food</TableCell>
                                <TableCell align="right">Mood</TableCell>
                                <TableCell align="right">Medication</TableCell>
                                <TableCell align="right">Notes</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {items.map((row) => (
                                <TableRow key={row.event_id}>
                                    <TableCell component="th" scope="row">
                                        {row.start_date_time}
                                    </TableCell>
                                    <TableCell>{row.end_date_time}</TableCell>
                                    <TableCell align="right">{getPatientName(row.user_id!)}</TableCell>
                                    <TableCell align="right">{row.food}</TableCell>
                                    <TableCell align="right">{row.mood}</TableCell>
                                    <TableCell align="right">{row.medication}</TableCell>
                                    <TableCell align="right">{row.notes}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Box>
        </Box>
    );
};

export default Events;
